#ifndef COMPONENTS_REMOTE_PAINT_CAPTURE_STATE_H_
#define COMPONENTS_REMOTE_PAINT_CAPTURE_STATE_H_
#include <memory>
#include <string>
#include <vector>
#include "base/functional/callback.h"
#include "base/values.h"
#include "third_party/skia/include/core/SkPicture.h"
namespace remote_paint {
struct LayerRecord {
  int local_id;
  float quad_scale;
  sk_sp<const SkPicture> picture;
};
struct Snapshot {
  std::string capture_id, producer, recording_thread, error;
  uint32_t frame_token = 0;
  int source_frame = 0;
  std::vector<LayerRecord> records;
};
struct CaptureRequest {
  std::string capture_id;
  base::OnceCallback<void(base::DictValue)> reply;
};
bool RequestCapture(int host, std::string capture_id,
                    base::OnceCallback<void(base::DictValue)> reply);
std::unique_ptr<CaptureRequest> TakeCapture(int host);
void EncodeAndReply(Snapshot snapshot, std::unique_ptr<CaptureRequest> request);
}
#endif
