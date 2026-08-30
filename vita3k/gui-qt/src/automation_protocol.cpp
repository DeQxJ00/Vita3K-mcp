#include <gui-qt/automation_protocol.h>

#include <ctrl/ctrl.h>

#include <algorithm>
#include <cctype>
#include <unordered_set>

namespace automation {

bool constant_time_equal(const std::string_view left, const std::string_view right) {
    const size_t count = std::max(left.size(), right.size());
    uint8_t difference = static_cast<uint8_t>(left.size() ^ right.size());
    for (size_t index = 0; index < count; ++index) {
        const uint8_t left_byte = index < left.size() ? static_cast<uint8_t>(left[index]) : 0;
        const uint8_t right_byte = index < right.size() ? static_cast<uint8_t>(right[index]) : 0;
        difference |= left_byte ^ right_byte;
    }
    return difference == 0;
}

std::optional<ControllerState> make_controller_state(
    const std::vector<std::string> &buttons,
    const std::optional<Stick> left,
    const std::optional<Stick> right) {
    static const std::unordered_set<std::string> supported{
        "select", "start", "up", "right", "down", "left", "triangle", "circle", "cross", "square", "ps",
        "l1", "r1", "l2", "r2", "l3", "r3"
    };
    for (const auto &button : buttons) {
        if (!supported.contains(button))
            return std::nullopt;
    }

    ControllerState state{};
    const auto contains = [&](const std::string_view name) {
        return std::find(buttons.begin(), buttons.end(), name) != buttons.end();
    };
    const auto common = [&](const std::string_view name, const uint32_t mask) {
        if (contains(name)) {
            state.buttons |= mask;
            state.buttons_ext |= mask;
        }
    };
    common("select", SCE_CTRL_SELECT);
    common("start", SCE_CTRL_START);
    common("up", SCE_CTRL_UP);
    common("right", SCE_CTRL_RIGHT);
    common("down", SCE_CTRL_DOWN);
    common("left", SCE_CTRL_LEFT);
    common("triangle", SCE_CTRL_TRIANGLE);
    common("circle", SCE_CTRL_CIRCLE);
    common("cross", SCE_CTRL_CROSS);
    common("square", SCE_CTRL_SQUARE);
    common("ps", SCE_CTRL_PSBUTTON);
    if (contains("l1")) {
        state.buttons |= SCE_CTRL_L;
        state.buttons_ext |= SCE_CTRL_L1;
    }
    if (contains("r1")) {
        state.buttons |= SCE_CTRL_R;
        state.buttons_ext |= SCE_CTRL_R1;
    }
    if (contains("l2")) {
        state.buttons |= SCE_CTRL_L;
        state.buttons_ext |= SCE_CTRL_L2;
    }
    if (contains("r2")) {
        state.buttons |= SCE_CTRL_R;
        state.buttons_ext |= SCE_CTRL_R2;
    }
    if (contains("l3"))
        state.buttons_ext |= SCE_CTRL_L3;
    if (contains("r3"))
        state.buttons_ext |= SCE_CTRL_R3;
    if (left) {
        state.axes[0] = static_cast<float>(std::clamp(left->x, -1.0, 1.0));
        state.axes[1] = static_cast<float>(std::clamp(left->y, -1.0, 1.0));
    }
    if (right) {
        state.axes[2] = static_cast<float>(std::clamp(right->x, -1.0, 1.0));
        state.axes[3] = static_cast<float>(std::clamp(right->y, -1.0, 1.0));
    }
    return state;
}

std::optional<TouchPort> parse_touch_port(const std::string_view port) {
    if (port == "front")
        return TouchPort::Front;
    if (port == "rear")
        return TouchPort::Rear;
    return std::nullopt;
}

bool valid_normalized_point(const double x, const double y) {
    return x >= 0.0 && x <= 1.0 && y >= 0.0 && y <= 1.0;
}

bool resolve_png_artifact_path(
    const std::filesystem::path &root,
    const std::filesystem::path &relative,
    std::filesystem::path &absolute) {
    if (relative.empty() || relative.is_absolute())
        return false;
    const auto clean_relative = relative.lexically_normal();
    if (clean_relative.empty() || *clean_relative.begin() == "..")
        return false;
    std::string extension = clean_relative.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(), [](const unsigned char value) { return static_cast<char>(std::tolower(value)); });
    if (extension != ".png")
        return false;
    const auto clean_root = std::filesystem::absolute(root).lexically_normal();
    const auto candidate = (clean_root / clean_relative).lexically_normal();
    const auto remainder = candidate.lexically_relative(clean_root);
    if (remainder.empty() || remainder.is_absolute() || *remainder.begin() == "..")
        return false;
    absolute = candidate;
    return true;
}

} // namespace automation
