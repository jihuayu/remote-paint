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
#include "components/remote_paint/capture_host_registry.h"
#include "components/remote_paint/encoded_picture.h"
#include "components/remote_paint/subscription_state.h"
#include "third_party/skia/include/core/SkPicture.h"
namespace remote_paint {
using CaptureOwner = CaptureHostRegistry<EncodedPicture>::Owner;
struct LayerRecord {
  int local_id;
  float quad_scale;
  sk_sp<const SkPicture> picture;
  uint64_t recording_key = 0;
  std::shared_ptr<const EncodedPicture> encoded;
  bool tiled = false;
  int tile_x = 0;
  int tile_y = 0;
  bool transient_canvas = false;
  int recording_width = 0, recording_height = 0;
};
struct Snapshot {
  std::string capture_id, producer, recording_thread, error;
  uint32_t frame_token = 0;
  int source_frame = 0;
  double recording_ms = 0;
  double encoding_started_ms = 0;
  int recording_cache_hits = 0;
  int recording_cache_misses = 0;
  int recording_encoding_misses = 0, recording_index_entries = 0;
  bool recording_index_enabled = false;
  int canvas_copies = 0, canvas_mapped_copies = 0, canvas_gpu_readbacks = 0;
  std::string error_code;
  bool force_resources = false;
  std::vector<LayerRecord> records;
  // DrawingBuffer resources originate from WebGL, never from missing SKPs.
  std::vector<int> webgl_layers;
};
struct CaptureRequest {
  int host;
  std::string capture_id;
  base::OnceCallback<void(base::DictValue)> reply;
  bool force_resources = false;
  CaptureOwner owner;
  std::optional<SubscriptionState::Ticket> subscription;
};
SubscriptionState::BindResult BindCaptureSubscription(int host,uintptr_t document,int world,
    const SubscriptionState::Key& key,const SubscriptionState::Context& context,
    uint64_t minimum_base,int minimum_source_frame,base::RepeatingClosure wake);
std::optional<SubscriptionState::Snapshot> InspectCaptureSubscription(
    int host,const SubscriptionState::Key& key);
bool UpdateCaptureSubscription(int host,const SubscriptionState::Key& key,
    uint64_t input_seq,bool full_resources,bool request_frame,int minimum_source_frame);
bool EnableCaptureSubscription(int host,const SubscriptionState::Key& key,bool enabled,int minimum_source_frame);
bool SetCaptureCadence(int host,const SubscriptionState::Key& key,uint64_t interval_us,uint64_t heartbeat_us);
base::DictValue CaptureSchedulerStats();
bool CancelCaptureSubscription(int host,const SubscriptionState::Key& key);
// Called synchronously before a new document can paint, on script-context
// release and frame destruction. Never waits for encoder/IPC completion.
void InvalidateCaptureDocument(uintptr_t document,std::optional<int> world=std::nullopt);
bool RequestCapture(int host, std::string capture_id,
                    base::OnceCallback<void(base::DictValue)> reply,
                    bool force_resources = false);
std::unique_ptr<CaptureRequest> TakeCapture(int host,int source_frame,bool damaged);
void ReleaseCaptureHost(int host);
std::string RememberCaptureFrameMarker(int host, const std::string& id, uint32_t token);
std::string LastCaptureFrameMarker(int host);
bool IsTiledCaptureEnabled();
void TrackLayerDamage(int host, int layer, int x, int y, int width, int height);
std::optional<std::array<int, 4>> TakeLayerDamage(int host, int layer);
uint64_t NewRecordingKey();
std::shared_ptr<const EncodedPicture> LookupCachedEncoding(const CaptureOwner& owner,
                                                            uint64_t key);
std::shared_ptr<const EncodedPicture> StoreCachedEncoding(const CaptureOwner& owner, uint64_t key,
                         std::shared_ptr<const EncodedPicture> encoded);
void EncodeAndReply(Snapshot snapshot, std::unique_ptr<CaptureRequest> request);
}
#endif
