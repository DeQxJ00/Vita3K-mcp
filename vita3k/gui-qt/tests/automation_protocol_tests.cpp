#include <gui-qt/automation_protocol.h>

#include <ctrl/ctrl.h>
#include <gtest/gtest.h>

TEST(AutomationProtocol, ConstantTimeAuthenticationComparison) {
    EXPECT_TRUE(automation::constant_time_equal("secret", "secret"));
    EXPECT_FALSE(automation::constant_time_equal("secret", "Secret"));
    EXPECT_FALSE(automation::constant_time_equal("secret", "secret-longer"));
}

TEST(AutomationProtocol, MapsButtonsAndClampsSticks) {
    const auto state = automation::make_controller_state(
        { "cross", "l2", "r3" }, automation::Stick{ 2.0, -2.0 }, automation::Stick{ 0.5, -0.5 });
    ASSERT_TRUE(state.has_value());
    EXPECT_NE(state->buttons & SCE_CTRL_CROSS, 0u);
    EXPECT_NE(state->buttons & SCE_CTRL_L, 0u);
    EXPECT_NE(state->buttons_ext & SCE_CTRL_L2, 0u);
    EXPECT_NE(state->buttons_ext & SCE_CTRL_R3, 0u);
    EXPECT_FLOAT_EQ(state->axes[0], 1.0f);
    EXPECT_FLOAT_EQ(state->axes[1], -1.0f);
    EXPECT_FALSE(automation::make_controller_state({ "invalid" }, {}, {}).has_value());
}

TEST(AutomationProtocol, ValidatesFrontAndRearTouch) {
    EXPECT_EQ(automation::parse_touch_port("front"), automation::TouchPort::Front);
    EXPECT_EQ(automation::parse_touch_port("rear"), automation::TouchPort::Rear);
    EXPECT_FALSE(automation::parse_touch_port("side").has_value());
    EXPECT_TRUE(automation::valid_normalized_point(0.0, 1.0));
    EXPECT_FALSE(automation::valid_normalized_point(-0.01, 0.5));
}

TEST(AutomationProtocol, ConfinesScreenshotPath) {
    std::filesystem::path result;
    const auto root = std::filesystem::temp_directory_path() / "vita3k-mcp-runs";
    EXPECT_TRUE(automation::resolve_png_artifact_path(root, "session/screenshots/0001.png", result));
    EXPECT_FALSE(automation::resolve_png_artifact_path(root, "../outside.png", result));
    EXPECT_FALSE(automation::resolve_png_artifact_path(root, "session/manifest.json", result));
    EXPECT_FALSE(automation::resolve_png_artifact_path(root, std::filesystem::absolute("outside.png"), result));
}
