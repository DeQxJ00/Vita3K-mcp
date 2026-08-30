#pragma once

#include <QObject>
#include <QByteArray>
#include <QString>

#include <cstdint>
#include <memory>

class MainWindow;
class QLocalServer;
class QLocalSocket;
class QJsonObject;
struct EmuEnvState;

// Private, opt-in control bridge used by the repository-local MCP sidecar.
// It is constructed only when VITA3K_MCP_PIPE and VITA3K_MCP_TOKEN are set.
class AutomationServer final : public QObject {
public:
    AutomationServer(MainWindow &window, EmuEnvState &emuenv, QObject *parent = nullptr);
    ~AutomationServer() override;

    bool start();

private:
    void acceptConnection();
    void readRequests();
    void disconnected();
    void handleRequest(const QJsonObject &request);
    QJsonObject dispatch(const QString &method, const QJsonObject &params);
    void sendSuccess(qint64 id, const QJsonObject &result);
    void sendError(qint64 id, const QString &code, const QString &message, bool retryable = false);
    void scheduleLaunch(const QJsonObject &params);
    void performLaunch(QJsonObject params);
    void clearInjectedInput();
    void clearTouch();
    bool resolveArtifactPath(const QString &relative, QString &absolute) const;
    QString currentPhase() const;

    MainWindow &m_window;
    EmuEnvState &m_emuenv;
    std::unique_ptr<QLocalServer> m_server;
    QLocalSocket *m_socket = nullptr;
    QByteArray m_buffer;
    QString m_pipe_name;
    QByteArray m_token_hash;
    bool m_has_token = false;
    QString m_artifact_root;
    QString m_operation_phase;
    QString m_operation_error;
    bool m_had_session = false;
    bool m_touch_active = false;
    int64_t m_touch_finger_id = 0x4D4350;
};
