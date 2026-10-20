#include "components/remote_paint/viz_capture.h"
#include "components/remote_paint/socket_transport.h"
#include "components/remote_paint/viz_delivery.h"
#include "components/remote_paint/capture_frame_marker.h"
#include <atomic>
#include <algorithm>
#include "base/containers/span.h"
#include <cstring>
#include <cstdint>
#include <set>
#include <optional>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <arpa/inet.h>
#include "base/environment.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/synchronization/lock.h"
#include "base/task/thread_pool.h"
#include "base/values.h"
#include "components/viz/service/display/aggregated_frame.h"
#include "components/viz/common/quads/aggregated_render_pass_draw_quad.h"
#include "components/viz/common/quads/shared_quad_state.h"
#include "components/viz/common/quads/solid_color_draw_quad.h"
#include "third_party/skia/include/core/SkRRect.h"
namespace remote_paint {
namespace {
bool TraceEnabled(){
  static const bool enabled=base::Environment::Create()->GetVar("REMOTE_PAINT_TRACE").value_or("")=="1";
  return enabled;
}
struct Delivery {
  explicit Delivery(const std::string& path) : socket(path) {}
  base::Lock lock;
  VizDeliveryQueue queue;
  VizSocket socket;
  bool scheduled = false;
};
void Drain(Delivery* delivery) {
  for (;;) {
    std::optional<VizDeliveryQueue::Packet> packet;
    {base::AutoLock guard(delivery->lock);packet=delivery->queue.Take();if(!packet){delivery->scheduled=false;return;}}
    bool written=delivery->socket.Send(packet->bytes);
    // A fault is tiny and its own connection can recover after a failed scene
    // write. Bound retry work; a genuinely unavailable endpoint still times out.
    if(packet->fault!=VizDeliveryQueue::Fault::kNone)
      for(int retry=0;!written&&retry<2;retry++)written=delivery->socket.Send(packet->bytes);
    if(TraceEnabled())LOG(ERROR)<<"REMOTE_PAINT_VIZ_WRITE id="<<packet->id<<" fault="<<static_cast<int>(packet->fault)<<" bytes="<<packet->bytes.size()<<" written="<<written;
    {base::AutoLock guard(delivery->lock);delivery->queue.Complete(written);}
  }
}
void Schedule(Delivery* delivery) {
  if(delivery->scheduled||!delivery->queue.ready())return;
  delivery->scheduled=true;
  base::ThreadPool::PostTask(FROM_HERE,{base::MayBlock(),base::TaskPriority::USER_VISIBLE},base::BindOnce(&Drain,delivery));
}
void WriteRect(BinaryWriter* wire,const gfx::Rect& rect){wire->F64(rect.x());wire->F64(rect.y());wire->F64(rect.right());wire->F64(rect.bottom());}
void WriteMatrix(BinaryWriter* wire,const gfx::Transform& transform){for(int row:{0,1,3})for(int col:{0,1,3})wire->F64(transform.rc(row,col));}

}
void EmitVizScene(const viz::AggregatedFrame& frame,const std::string& tag,std::pair<uint32_t,uint32_t> ns,uint32_t frame_token){
  static base::NoDestructor<std::optional<std::string>> endpoint(base::Environment::Create()->GetVar("REMOTE_PAINT_SOCKET"));
  if(!*endpoint || tag.empty())return;
  const auto marker=ParseCaptureFrameMarker(tag);if(!marker)return;const auto& id=marker->id;
  static base::NoDestructor<Delivery> delivery(**endpoint);
  bool admitted;
  {base::AutoLock guard(delivery->lock);admitted=delivery->queue.Reserve(id);if(!admitted)Schedule(delivery.get());}
  if(TraceEnabled())LOG(ERROR)<<"REMOTE_PAINT_VIZ_EMIT id="<<id<<" ns="<<ns.first<<":"<<ns.second<<" admitted="<<admitted;
  if(!admitted)return;
  BinaryWriter wire;wire.Bytes("RVB2");wire.U8(1);wire.U8(1);wire.String(id);wire.U32(ns.first);wire.U32(ns.second);
  if(!marker->Matches(frame_token)){
    wire.U32(0);wire.U8(1);wire.String("Captured compositor frame superseded before aggregation");
    if(TraceEnabled())LOG(ERROR)<<"REMOTE_PAINT_VIZ_SUPERSEDED id="<<id<<" requested="<<marker->requested_token<<" actual="<<frame_token;
    base::AutoLock guard(delivery->lock);delivery->queue.Submit(id,std::move(wire.bytes));Schedule(delivery.get());return;
  }
  const size_t pass_count_offset=wire.size();wire.U32(0);uint32_t emitted_passes=0;size_t count=0;std::string error;
  for(const auto& pass:frame.render_pass_list){
    if(emitted_passes>=64){error="Viz pass budget exceeded";break;}
    wire.String(base::NumberToString(pass->id.GetUnsafeValue()));WriteRect(&wire,pass->output_rect);const size_t quad_count_offset=wire.size();wire.U32(0);uint32_t emitted_quads=0;
    // Viz order is front to back. Keep it explicit; the Viewer reverses each
    // pass for painter's order and applies the actual quad clip/transform.
    for(const auto* quad:pass->quad_list){
      if(++count>2048){error="Viz quad budget exceeded";break;}
      const auto& sqs=*quad->shared_quad_state;
      if(!sqs.quad_to_target_transform.Is2dTransform() || sqs.sorting_context_id){error="Unsupported Viz 3D transform or sorting context";break;}
      if(sqs.mask_filter_info.HasGradientMask()){error="Unsupported Viz gradient mask";break;}
      if(sqs.blend_mode!=SkBlendMode::kSrcOver){error="Unsupported Viz blend mode "+base::NumberToString(static_cast<int>(sqs.blend_mode));break;}
      uint8_t kind=0;const viz::AggregatedRenderPassDrawQuad* child=nullptr;const viz::SolidColorDrawQuad* solid=nullptr;
      if(quad->material==viz::DrawQuad::Material::kSolidColor){kind=1;solid=viz::SolidColorDrawQuad::MaterialCast(quad);}
      else if(quad->material==viz::DrawQuad::Material::kAggregatedRenderPass){
        child=viz::AggregatedRenderPassDrawQuad::MaterialCast(quad);
        if(!child->filters.IsEmpty()||!child->backdrop_filters.IsEmpty()||child->resource_id!=viz::kInvalidResourceId){error="Unsupported Viz filtered/masked render pass";break;}kind=2;
      }else if(quad->material==viz::DrawQuad::Material::kTiledContent || quad->material==viz::DrawQuad::Material::kTextureContent || quad->material==viz::DrawQuad::Material::kPictureContent)kind=3;
      else{error="Unsupported Viz quad material";break;}
      wire.U8(kind);wire.I32(sqs.layer_id);wire.U32(sqs.layer_namespace_id.first);wire.U32(sqs.layer_namespace_id.second);WriteMatrix(&wire,sqs.quad_to_target_transform);WriteRect(&wire,quad->visible_rect);WriteRect(&wire,quad->rect);wire.F64(sqs.quad_layer_rect.x());wire.F64(sqs.quad_layer_rect.y());wire.F64(sqs.opacity);wire.U8(sqs.clip_rect?1:0);if(sqs.clip_rect)WriteRect(&wire,*sqs.clip_rect);
      // Like SoftwareRenderer::SetClipRRect, this clip is in target space,
      // before the quad transform. Composited carets inherit input radii.
      if(!sqs.mask_filter_info.IsEmpty()){
        const auto rounded=static_cast<SkRRect>(sqs.mask_filter_info.rounded_corner_bounds());
        const auto bounds=rounded.rect();
        wire.U8(1);wire.F64(bounds.left());wire.F64(bounds.top());wire.F64(bounds.right());wire.F64(bounds.bottom());for(int corner=0;corner<4;corner++){const auto radius=rounded.radii(static_cast<SkRRect::Corner>(corner));wire.F64(radius.x());wire.F64(radius.y());}
      }else wire.U8(0);wire.U32(quad->resource_id.GetUnsafeValue());
      if(kind==1){const auto color=solid->color;wire.F64(color.fR);wire.F64(color.fG);wire.F64(color.fB);wire.F64(color.fA);}
      else if(kind==2)wire.String(base::NumberToString(child->render_pass_id.GetUnsafeValue()));
      ++emitted_quads;wire.SetU32(quad_count_offset,emitted_quads);
    }
    ++emitted_passes;wire.SetU32(pass_count_offset,emitted_passes);
    if(!error.empty())break;
  }
  wire.U8(error.empty()?0:1);if(!error.empty())wire.String(error);
  if(wire.size()>256*1024){
    wire.bytes.clear();wire.Bytes("RVB2");wire.U8(1);wire.U8(1);wire.String(id);wire.U32(ns.first);wire.U32(ns.second);wire.U32(0);wire.U8(1);wire.String("Viz scene byte budget exceeded");
  }
  {base::AutoLock guard(delivery->lock);delivery->queue.Submit(id,std::move(wire.bytes));Schedule(delivery.get());}
}
}
