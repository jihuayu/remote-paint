#ifndef COMPONENTS_REMOTE_PAINT_CAPTURE_FRAME_MARKER_H_
#define COMPONENTS_REMOTE_PAINT_CAPTURE_FRAME_MARKER_H_
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <optional>
#include <string>
#include <string_view>

namespace remote_paint {
struct CaptureFrameMarker {
  std::string id;
  uint32_t requested_token = 0;
  bool versioned = false;
  bool Matches(uint32_t actual_token) const {
    return !versioned || requested_token == actual_token;
  }
};
std::string MakeCaptureFrameMarker(std::string_view id, uint32_t token);
std::optional<CaptureFrameMarker> ParseCaptureFrameMarker(std::string_view tag);

// One private Broker accepts at most four outstanding captures. Keep only the
// most recently captured hosts; returning to an evicted host requires a fresh
// request. This does not add another unbounded static per-navigation map.
class CaptureFrameMarkers {
 public:
  explicit CaptureFrameMarkers(size_t capacity = 4);
  ~CaptureFrameMarkers();
  CaptureFrameMarkers(const CaptureFrameMarkers&) = delete;
  CaptureFrameMarkers& operator=(const CaptureFrameMarkers&) = delete;
  std::string Remember(int host, std::string_view id, uint32_t token);
  std::string Last(int host) const;
  void Forget(int host);
  size_t size() const { return tags_.size(); }
 private:
  const size_t capacity_;
  std::map<int, std::string> tags_;
  std::deque<int> order_;
};
}  // namespace remote_paint
#endif
