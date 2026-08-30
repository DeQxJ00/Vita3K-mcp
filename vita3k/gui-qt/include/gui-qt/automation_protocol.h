#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace automation {

struct Stick {
    double x = 0.0;
    double y = 0.0;
};

struct ControllerState {
    uint32_t buttons = 0;
    uint32_t buttons_ext = 0;
    std::array<float, 4> axes{};
};

enum class TouchPort {
    Front,
    Rear,
};

bool constant_time_equal(std::string_view left, std::string_view right);
std::optional<ControllerState> make_controller_state(
    const std::vector<std::string> &buttons,
    std::optional<Stick> left,
    std::optional<Stick> right);
std::optional<TouchPort> parse_touch_port(std::string_view port);
bool valid_normalized_point(double x, double y);
bool resolve_png_artifact_path(
    const std::filesystem::path &root,
    const std::filesystem::path &relative,
    std::filesystem::path &absolute);

} // namespace automation
