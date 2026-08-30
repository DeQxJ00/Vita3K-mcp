#include <gui-qt/automation_server.h>

#include <gui-qt/apps_list.h>
#include <gui-qt/automation_protocol.h>
#include <gui-qt/main_window.h>

#include <app/functions.h>
#include <app/session_controller.h>
#include <app/state.h>
#include <archive.h>
#include <ctrl/ctrl.h>
#include <ctrl/state.h>
#include <display/state.h>
#include <emuenv/state.h>
#include <interface.h>
#include <io/state.h>
#include <packages/sfo.h>
#include <touch/functions.h>
#include <touch/state.h>
#include <util/fs.h>
#include <util/log.h>
#include <util/string_utils.h>

#include <SDL3/SDL_events.h>

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QTimer>

#include <algorithm>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace {
constexpr qsizetype MAX_MESSAGE_SIZE = 1024 * 1024;

QJsonObject error_object(const QString &code, const QString &message, const bool retryable = false) {
    return {
        { QStringLiteral("code"), code },
        { QStringLiteral("message"), message },
        { QStringLiteral("retryable"), retryable },
    };
}

std::vector<std::string> string_array(const QJsonArray &values) {
    std::vector<std::string> result;
    result.reserve(values.size());
    for (const auto &value : values) {
        if (value.isString())
            result.push_back(value.toString().toStdString());
    }
    return result;
}
} // namespace

AutomationServer::AutomationServer(MainWindow &window, EmuEnvState &emuenv, QObject *parent)
    : QObject(parent)
    , m_window(window)
    , m_emuenv(emuenv)
    , m_server(std::make_unique<QLocalServer>(this))
    , m_pipe_name(qEnvironmentVariable("VITA3K_MCP_PIPE"))
    , m_token_hash(QCryptographicHash::hash(qEnvironmentVariable("VITA3K_MCP_TOKEN").toUtf8(), QCryptographicHash::Sha256))
    , m_has_token(!qEnvironmentVariable("VITA3K_MCP_TOKEN").isEmpty())
    , m_artifact_root(QDir::cleanPath(qEnvironmentVariable("VITA3K_MCP_ARTIFACT_ROOT"))) {
    connect(m_server.get(), &QLocalServer::newConnection, this, &AutomationServer::acceptConnection);
}

AutomationServer::~AutomationServer() {
    clearInjectedInput();
    clearTouch();
    if (m_socket)
        m_socket->disconnectFromServer();
    if (m_server->isListening())
        m_server->close();
}

bool AutomationServer::start() {
    if (m_pipe_name.isEmpty() || !m_has_token || m_artifact_root.isEmpty()) {
        LOG_ERROR("MCP automation bridge is missing required environment variables.");
        return false;
    }
    QDir().mkpath(m_artifact_root);
    m_artifact_root = QDir(m_artifact_root).absolutePath();
    QLocalServer::removeServer(m_pipe_name);
    m_server->setSocketOptions(QLocalServer::UserAccessOption);
    if (!m_server->listen(m_pipe_name)) {
        LOG_ERROR("Failed to listen on MCP automation pipe: {}", m_server->errorString().toStdString());
        return false;
    }
    LOG_INFO("MCP automation bridge ready.");
    return true;
}

void AutomationServer::acceptConnection() {
    while (QLocalSocket *candidate = m_server->nextPendingConnection()) {
        if (m_socket) {
            candidate->disconnectFromServer();
            candidate->deleteLater();
            continue;
        }
        m_socket = candidate;
        connect(m_socket, &QLocalSocket::readyRead, this, &AutomationServer::readRequests);
        connect(m_socket, &QLocalSocket::disconnected, this, &AutomationServer::disconnected);
    }
}

void AutomationServer::readRequests() {
    if (!m_socket)
        return;
    m_buffer.append(m_socket->readAll());
    if (m_buffer.size() > MAX_MESSAGE_SIZE) {
        m_socket->disconnectFromServer();
        return;
    }
    while (true) {
        const qsizetype newline = m_buffer.indexOf('\n');
        if (newline < 0)
            return;
        const QByteArray line = m_buffer.left(newline);
        m_buffer.remove(0, newline + 1);
        if (line.isEmpty())
            continue;
        QJsonParseError parse_error{};
        const QJsonDocument document = QJsonDocument::fromJson(line, &parse_error);
        if (parse_error.error != QJsonParseError::NoError || !document.isObject()) {
            sendError(-1, QStringLiteral("INVALID_REQUEST"), QStringLiteral("Malformed JSON request."));
            continue;
        }
        handleRequest(document.object());
    }
}

void AutomationServer::disconnected() {
    clearInjectedInput();
    clearTouch();
    m_buffer.clear();
    if (m_socket) {
        m_socket->deleteLater();
        m_socket = nullptr;
    }
}

void AutomationServer::handleRequest(const QJsonObject &request) {
    const qint64 id = request.value(QStringLiteral("id")).toInteger(-1);
    const QByteArray supplied_hash = QCryptographicHash::hash(request.value(QStringLiteral("token")).toString().toUtf8(), QCryptographicHash::Sha256);
    if (request.value(QStringLiteral("version")).toInt() != 1) {
        sendError(id, QStringLiteral("UNSUPPORTED_VERSION"), QStringLiteral("Only control protocol version 1 is supported."));
        return;
    }
    if (!automation::constant_time_equal(
            std::string_view(supplied_hash.constData(), supplied_hash.size()),
            std::string_view(m_token_hash.constData(), m_token_hash.size()))) {
        sendError(id, QStringLiteral("UNAUTHORIZED"), QStringLiteral("Invalid automation token."));
        return;
    }
    const QString method = request.value(QStringLiteral("method")).toString();
    if (method.isEmpty()) {
        sendError(id, QStringLiteral("INVALID_REQUEST"), QStringLiteral("Method is required."));
        return;
    }
    try {
        sendSuccess(id, dispatch(method, request.value(QStringLiteral("params")).toObject()));
    } catch (const std::exception &error) {
        sendError(id, QStringLiteral("BRIDGE_ERROR"), QString::fromUtf8(error.what()));
    }
}

QJsonObject AutomationServer::dispatch(const QString &method, const QJsonObject &params) {
    if (method == QStringLiteral("hello")) {
        return { { QStringLiteral("protocolVersion"), 1 }, { QStringLiteral("application"), QStringLiteral("Vita3K") } };
    }
    if (method == QStringLiteral("apps.list")) {
        if (params.value(QStringLiteral("refresh")).toBool(false)) {
            if (!app::init_apps_list(m_emuenv))
                throw std::runtime_error("Failed to refresh application list.");
            if (m_window.m_apps_list_widget)
                m_window.m_apps_list_widget->refresh(true);
        }
        QJsonArray apps;
        for (const auto &entry : app::get_apps(m_emuenv)) {
            apps.append(QJsonObject{
                { QStringLiteral("titleId"), QString::fromStdString(entry.title_id) },
                { QStringLiteral("title"), QString::fromStdString(entry.title) },
                { QStringLiteral("shortTitle"), QString::fromStdString(entry.stitle) },
                { QStringLiteral("version"), QString::fromStdString(entry.app_ver) },
                { QStringLiteral("category"), QString::fromStdString(entry.category) },
                { QStringLiteral("contentId"), QString::fromStdString(entry.content_id) },
            });
        }
        return { { QStringLiteral("apps"), apps } };
    }
    if (method == QStringLiteral("app.launch")) {
        scheduleLaunch(params);
        return { { QStringLiteral("accepted"), true }, { QStringLiteral("phase"), m_operation_phase } };
    }
    if (method == QStringLiteral("session.status")) {
        const QString phase = currentPhase();
        QJsonObject result{
            { QStringLiteral("phase"), phase },
            { QStringLiteral("titleId"), QString::fromStdString(m_emuenv.io.title_id) },
            { QStringLiteral("title"), QString::fromStdString(m_emuenv.current_app_title) },
            { QStringLiteral("fps"), static_cast<int>(m_emuenv.fps) },
            { QStringLiteral("resolution"), QJsonObject{
                { QStringLiteral("width"), m_emuenv.display.sce_frame.image_size.x },
                { QStringLiteral("height"), m_emuenv.display.sce_frame.image_size.y },
            } },
        };
        if (!m_operation_error.isEmpty())
            result.insert(QStringLiteral("error"), m_operation_error);
        return result;
    }
    if (method == QStringLiteral("screen.capture")) {
        QString target;
        if (!resolveArtifactPath(params.value(QStringLiteral("relativePath")).toString(), target))
            throw std::runtime_error("Screenshot path is outside the MCP artifact directory.");
        uint32_t width = 0;
        uint32_t height = 0;
        if (!save_current_app_frame_png(m_emuenv, fs_utils::utf8_to_path(target.toStdString()), width, height))
            throw std::runtime_error("Failed to capture the current application frame.");
        return { { QStringLiteral("path"), target }, { QStringLiteral("width"), static_cast<int>(width) }, { QStringLiteral("height"), static_cast<int>(height) } };
    }
    if (method == QStringLiteral("input.set")) {
        std::vector<std::string> button_names;
        for (const auto &value : params.value(QStringLiteral("buttons")).toArray()) {
            button_names.push_back(value.toString().toStdString());
        }
        const auto left = params.value(QStringLiteral("leftStick")).toObject();
        const auto right = params.value(QStringLiteral("rightStick")).toObject();
        const auto make_stick = [](const QJsonObject &value) -> std::optional<automation::Stick> {
            if (value.isEmpty())
                return std::nullopt;
            return automation::Stick{ value.value(QStringLiteral("x")).toDouble(), value.value(QStringLiteral("y")).toDouble() };
        };
        const auto mapped = automation::make_controller_state(button_names, make_stick(left), make_stick(right));
        if (!mapped)
            throw std::runtime_error("Unsupported controller button.");
        std::lock_guard<std::mutex> lock(m_emuenv.ctrl.mutex);
        auto &input = m_emuenv.ctrl.automation_state;
        input = {};
        input.buttons = mapped->buttons;
        input.buttons_ext = mapped->buttons_ext;
        std::copy(mapped->axes.begin(), mapped->axes.end(), input.axes);
        return { { QStringLiteral("applied"), true } };
    }
    if (method == QStringLiteral("input.clear")) {
        clearInjectedInput();
        return { { QStringLiteral("released"), true } };
    }
    if (method == QStringLiteral("touch.event")) {
        const QString action = params.value(QStringLiteral("action")).toString();
        const QString port = params.value(QStringLiteral("port")).toString(QStringLiteral("front"));
        const auto touch_port = automation::parse_touch_port(port.toStdString());
        if (!touch_port)
            throw std::runtime_error("Touch port must be front or rear.");
        if (action == QStringLiteral("up")) {
            clearTouch();
            return { { QStringLiteral("released"), true } };
        }
        if (action != QStringLiteral("down") && action != QStringLiteral("move"))
            throw std::runtime_error("Touch action must be down, move, or up.");
        const double x = params.value(QStringLiteral("x")).toDouble(-1.0);
        const double y = params.value(QStringLiteral("y")).toDouble(-1.0);
        if (!automation::valid_normalized_point(x, y))
            throw std::runtime_error("Touch coordinates must be between 0 and 1.");
        SDL_TouchFingerEvent event{};
        event.type = action == QStringLiteral("down") ? SDL_EVENT_FINGER_DOWN : SDL_EVENT_FINGER_MOTION;
        event.fingerID = m_touch_finger_id;
        event.x = static_cast<float>(x);
        event.y = static_cast<float>(y);
        m_emuenv.touch.touchscreen_port = *touch_port == automation::TouchPort::Rear ? SCE_TOUCH_PORT_BACK : SCE_TOUCH_PORT_FRONT;
        handle_touch_event(m_emuenv.touch, event);
        m_touch_active = true;
        return { { QStringLiteral("applied"), true } };
    }
    if (method == QStringLiteral("touch.clear")) {
        clearTouch();
        return { { QStringLiteral("released"), true } };
    }
    if (method == QStringLiteral("session.pause")) {
        const bool paused = params.value(QStringLiteral("paused")).toBool();
        if (!m_window.m_app_session.set_pause_reason(app::AppSessionPauseReason::User, paused))
            throw std::runtime_error("No running application to pause or resume.");
        m_window.refresh_emulation_actions();
        return { { QStringLiteral("paused"), paused } };
    }
    if (method == QStringLiteral("session.restart")) {
        if (!m_window.m_app_session.is_running())
            throw std::runtime_error("No running application to restart.");
        m_operation_phase = QStringLiteral("launching");
        QTimer::singleShot(0, &m_window, [this]() {
            m_window.restart_running_app();
            m_operation_phase.clear();
        });
        return { { QStringLiteral("accepted"), true } };
    }
    if (method == QStringLiteral("session.stop")) {
        clearInjectedInput();
        clearTouch();
        if (m_window.m_app_session.has_active_session())
            m_window.on_stop_triggered();
        m_had_session = true;
        m_operation_phase.clear();
        return { { QStringLiteral("stopped"), true } };
    }
    if (method == QStringLiteral("emulator.shutdown")) {
        clearInjectedInput();
        clearTouch();
        QTimer::singleShot(0, &m_window, [this]() {
            m_window.m_is_app_closing = true;
            if (m_window.m_app_session.has_active_session())
                m_window.on_game_closed();
            QCoreApplication::quit();
        });
        return { { QStringLiteral("accepted"), true } };
    }
    throw std::runtime_error(QStringLiteral("Unknown method: %1").arg(method).toStdString());
}

void AutomationServer::sendSuccess(const qint64 id, const QJsonObject &result) {
    if (!m_socket)
        return;
    const QJsonObject response{
        { QStringLiteral("id"), id },
        { QStringLiteral("ok"), true },
        { QStringLiteral("result"), result },
    };
    m_socket->write(QJsonDocument(response).toJson(QJsonDocument::Compact) + '\n');
    m_socket->flush();
}

void AutomationServer::sendError(const qint64 id, const QString &code, const QString &message, const bool retryable) {
    if (!m_socket)
        return;
    const QJsonObject response{
        { QStringLiteral("id"), id },
        { QStringLiteral("ok"), false },
        { QStringLiteral("error"), error_object(code, message, retryable) },
    };
    m_socket->write(QJsonDocument(response).toJson(QJsonDocument::Compact) + '\n');
    m_socket->flush();
}

void AutomationServer::scheduleLaunch(const QJsonObject &params) {
    const QString title_id = params.value(QStringLiteral("titleId")).toString();
    const QString content_path = params.value(QStringLiteral("contentPath")).toString();
    if (title_id.isEmpty() == content_path.isEmpty())
        throw std::runtime_error("Exactly one of titleId or contentPath is required.");
    if (m_window.m_app_session.has_active_session() && !params.value(QStringLiteral("replace")).toBool(false))
        throw std::runtime_error("An application is already running.");
    m_operation_error.clear();
    m_operation_phase = content_path.isEmpty() ? QStringLiteral("launching") : QStringLiteral("installing");
    QTimer::singleShot(0, &m_window, [this, params]() { performLaunch(params); });
}

void AutomationServer::performLaunch(QJsonObject params) {
    QString title_id = params.value(QStringLiteral("titleId")).toString();
    const QString content_path = params.value(QStringLiteral("contentPath")).toString();
    if (m_window.m_app_session.has_active_session())
        m_window.on_stop_triggered();

    if (!content_path.isEmpty()) {
        const fs::path path = fs_utils::utf8_to_path(content_path.toStdString());
        if (!fs::exists(path)) {
            m_operation_phase = QStringLiteral("failed");
            m_operation_error = QStringLiteral("Content path does not exist.");
            return;
        }
        const std::string extension = string_utils::tolower(path.extension().string());
        if (extension == ".vpk" || extension == ".zip") {
            const auto installed = install_archive(m_emuenv, path);
            const auto app = std::find_if(installed.begin(), installed.end(), [](const ContentInfo &entry) {
                return entry.state && entry.category == "gd";
            });
            if (app != installed.end())
                title_id = QString::fromStdString(app->title_id);
        } else if (fs::is_directory(path)) {
            if (install_contents(m_emuenv, path) == 1 && m_emuenv.app_info.app_category == "gd")
                title_id = QString::fromStdString(m_emuenv.app_info.app_title_id);
        } else {
            m_operation_phase = QStringLiteral("failed");
            m_operation_error = QStringLiteral("Content must be a VPK, ZIP, or directory.");
            return;
        }
        if (!app::init_apps_list(m_emuenv)) {
            m_operation_phase = QStringLiteral("failed");
            m_operation_error = QStringLiteral("Failed to refresh application list after install.");
            return;
        }
        m_window.on_install_finished();
        m_operation_phase = QStringLiteral("launching");
    }

    if (title_id.isEmpty()) {
        m_operation_phase = QStringLiteral("failed");
        m_operation_error = QStringLiteral("No launchable game was found in the supplied content.");
        return;
    }
    AppLaunchRequest request{
        .app_path = title_id.toStdString(),
        .argv = string_array(params.value(QStringLiteral("appArgs")).toArray()),
        .reason = AppLaunchReason::User,
    };
    m_window.boot_game(request, false);
    m_had_session = true;
    if (m_window.m_app_session.is_running()) {
        m_operation_phase.clear();
        m_operation_error.clear();
    } else {
        m_operation_phase = QStringLiteral("failed");
        m_operation_error = QStringLiteral("Vita3K failed to launch the application.");
    }
}

void AutomationServer::clearInjectedInput() {
    std::lock_guard<std::mutex> lock(m_emuenv.ctrl.mutex);
    m_emuenv.ctrl.automation_state = {};
}

void AutomationServer::clearTouch() {
    if (!m_touch_active)
        return;
    SDL_TouchFingerEvent event{};
    event.type = SDL_EVENT_FINGER_UP;
    event.fingerID = m_touch_finger_id;
    handle_touch_event(m_emuenv.touch, event);
    m_touch_active = false;
}

bool AutomationServer::resolveArtifactPath(const QString &relative, QString &absolute) const {
    std::filesystem::path candidate;
    if (!automation::resolve_png_artifact_path(
            std::filesystem::path(m_artifact_root.toStdWString()),
            std::filesystem::path(relative.toStdWString()), candidate))
        return false;
    absolute = QString::fromStdWString(candidate.wstring());
    return true;
}

QString AutomationServer::currentPhase() const {
    if (!m_operation_phase.isEmpty())
        return m_operation_phase;
    if (m_window.m_app_session.is_paused())
        return QStringLiteral("paused");
    switch (m_window.m_app_session.phase()) {
    case app::AppSessionPhase::Idle: return m_had_session ? QStringLiteral("stopped") : QStringLiteral("idle");
    case app::AppSessionPhase::Launching: return QStringLiteral("launching");
    case app::AppSessionPhase::Running: return QStringLiteral("running");
    case app::AppSessionPhase::Stopping: return QStringLiteral("stopping");
    }
    return QStringLiteral("failed");
}
