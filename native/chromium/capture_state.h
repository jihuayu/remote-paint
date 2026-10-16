#ifndef COMPONENTS_REMOTE_PAINT_CAPTURE_STATE_H_
#define COMPONENTS_REMOTE_PAINT_CAPTURE_STATE_H_
#include <cstdint>
#include <array>
#include <optional>
#include <memory>
#include <string>
#include <vector>
#include "base/functional/callback.h"
#include "base/values.h"
#include "components/remote_paint/serializer.h"
#include "third_party/skia/include/core/SkPicture.h"
namespace remote_paint {
struct EncodedPicture {
  SerializedPicture serialized;
  std::string base64;
  std::string resource_id;
};
struct LayerRecord {
  int local_id;
  float quad_scale;
  sk_sp<const SkPicture> picture;
  uint64_t recording_key = 0;
  std::shared_ptr<const EncodedPicture> encoded;
  bool tiled = false;
  int tile_x = 0;
  int tile_y = 0;
};
struct Snapshot {
  std::string capture_id, producer, recording_thread, error;
  uint32_t frame_token = 0;
  int source_frame = 0;
  double recording_ms = 0;
  double encoding_started_ms = 0;
  int recording_cache_hits = 0;
  int recording_cache_misses = 0;
  bool force_resources = false;
  std::vector<LayerRecord> records;
};
struct CaptureRequest {
  int host;
  std::string capture_id;
  base::OnceCallback<void(base::DictValue)> reply;
  bool force_resources = false;
};
bool RequestCapture(int host, std::string capture_id,
                    base::OnceCallback<void(base::DictValue)> reply,
                    bool force_resources = false);
std::unique_ptr<CaptureRequest> TakeCapture(int host);
bool IsTiledCaptureEnabled();
void TrackLayerDamage(int host, int layer, int x, int y, int width, int height);
std::optional<std::array<int, 4>> TakeLayerDamage(int host, int layer);
uint64_t NewRecordingKey();
std::shared_ptr<const EncodedPicture> LookupCachedEncoding(int host,
                                                            uint64_t key);
void StoreCachedEncoding(int host, uint64_t key,
                         std::shared_ptr<const EncodedPicture> encoded);
void EncodeAndReply(Snapshot snapshot, std::unique_ptr<CaptureRequest> request);
}
#endif
