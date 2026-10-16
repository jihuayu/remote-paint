#include "components/remote_paint/viz_capture.h"
#include "components/remote_paint/socket_transport.h"
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
std::atomic<int> pending_writes{0};
void WriteRect(BinaryWriter* wire,const gfx::Rect& rect){wire->F64(rect.x());wire->F64(rect.y());wire->F64(rect.right());wire->F64(rect.bottom());}
void WriteMatrix(BinaryWriter* wire,const gfx::Transform& transform){for(int row:{0,1,3})for(int col:{0,1,3})wire->F64(transform.rc(row,col));}
void WriteScene(std::string path,std::string bytes){
  static base::NoDestructor<VizSocket> socket(path);
  socket->Send(bytes);
  pending_writes.fetch_sub(1);
}
}
void EmitVizScene(const viz::AggregatedFrame& frame,const std::string& id,std::pair<uint32_t,uint32_t> ns){
  static base::NoDestructor<std::optional<std::string>> endpoint(base::Environment::Create()->GetVar("REMOTE_PAINT_SOCKET"));
  if(!*endpoint || id.empty())return;
  // Viz calls this on one display sequence. Bounded deduplication also avoids
  // repeatedly emitting the same tagged surface on unrelated display frames.
  static base::NoDestructor<std::set<std::string>> seen;
  if(seen->contains(id))return;
  if(seen->size()>=256)seen->clear();seen->insert(id);
  if(pending_writes.fetch_add(1)>=2){pending_writes.fetch_sub(1);return;}
  BinaryWriter wire;wire.Bytes("RVB2");wire.U8(1);wire.U8(1);wire.String(id);wire.U32(ns.first);wire.U32(ns.second);
  const size_t pass_count_offset=wire.size();wire.U32(0);uint32_t emitted_passes=0;size_t count=0;std::string error;
  for(const auto& pass:frame.render_pass_list){
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
  if(wire.size()>256*1024){pending_writes.fetch_sub(1);return;}
  base::ThreadPool::PostTask(FROM_HERE,{base::MayBlock(),base::TaskPriority::USER_VISIBLE},base::BindOnce(&WriteScene,**endpoint,std::move(wire.bytes)));
}
}
