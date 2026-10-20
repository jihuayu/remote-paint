#include "components/remote_paint/capture_frame_marker.h"
#include <algorithm>
#include <cassert>
#include "base/strings/string_number_conversions.h"

namespace remote_paint {
std::string MakeCaptureFrameMarker(std::string_view id, uint32_t token) {
  if (id.empty() || id.size() > 128 || token == 0) return {};
  return "rp1/" + std::to_string(token) + "/" + std::string(id);
}
std::optional<CaptureFrameMarker> ParseCaptureFrameMarker(std::string_view tag) {
  if (tag.empty() || tag.size() > 256) return std::nullopt;
  if (!tag.starts_with("rp1/")) {
    if (tag.size() > 128) return std::nullopt;
    return CaptureFrameMarker{std::string(tag), 0, false};
  }
  const auto slash = tag.find('/', 4);
  if (slash == std::string_view::npos) return std::nullopt;
  const auto digits = tag.substr(4, slash - 4), id = tag.substr(slash + 1);
  if (digits.empty() || digits.size() > 10 || id.empty() || id.size() > 128)
    return std::nullopt;
  uint32_t token = 0;
  if (digits.find_first_not_of("0123456789") != std::string_view::npos ||
      !base::StringToUint(digits, &token) || token == 0)
    return std::nullopt;
  return CaptureFrameMarker{std::string(id), token, true};
}
CaptureFrameMarkers::CaptureFrameMarkers(size_t capacity) : capacity_(capacity) {
  assert(capacity_ > 0);
}
CaptureFrameMarkers::~CaptureFrameMarkers() = default;
std::string CaptureFrameMarkers::Remember(int host, std::string_view id, uint32_t token) {
  auto marker = MakeCaptureFrameMarker(id, token);
  if (marker.empty()) return {};
  if (tags_.contains(host)) {
    std::erase(order_, host);
  } else if (tags_.size() >= capacity_) {
    tags_.erase(order_.front());
    order_.pop_front();
  }
  tags_[host] = marker;
  order_.push_back(host);
  return marker;
}
std::string CaptureFrameMarkers::Last(int host) const {
  const auto found = tags_.find(host);
  return found == tags_.end() ? std::string() : found->second;
}
void CaptureFrameMarkers::Forget(int host) {
  tags_.erase(host); std::erase(order_, host);
}
}  // namespace remote_paint
