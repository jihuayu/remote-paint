#include "components/remote_paint/viz_capture.h"
#include <atomic>
#include <algorithm>
#include "base/containers/span.h"
#include <cstring>
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
#include "base/task/thread_pool.h"
#include "base/values.h"
#include "components/viz/service/display/aggregated_frame.h"
#include "components/viz/common/quads/aggregated_render_pass_draw_quad.h"
#include "components/viz/common/quads/shared_quad_state.h"
#include "components/viz/common/quads/solid_color_draw_quad.h"
namespace remote_paint {
namespace {
std::atomic<int> pending_writes{0};
base::ListValue Numbers(std::initializer_list<double> values){base::ListValue out;for(double value:values)out.Append(value);return out;}
base::ListValue Rect(const gfx::Rect& r){return Numbers({double(r.x()),double(r.y()),double(r.right()),double(r.bottom())});}
base::ListValue Matrix(const gfx::Transform& t){
  base::ListValue values;
  for(int row:{0,1,3})for(int col:{0,1,3})values.Append(t.rc(row,col));
  return values;
}
void WriteScene(std::string path,std::string bytes){
  const int fd=socket(AF_UNIX,SOCK_STREAM,0);
  if(fd>=0){
    sockaddr_un address{};address.sun_family=AF_UNIX;
    if(path.size()<sizeof(address.sun_path)){
      // SAFETY: The path length is checked against the destination above.
      std::ranges::copy(path,std::begin(address.sun_path));
      timeval timeout{1,0};setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
#if defined(SO_NOSIGPIPE)
      int no_sigpipe=1;setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&no_sigpipe,sizeof(no_sigpipe));
#endif
      if(connect(fd,reinterpret_cast<sockaddr*>(&address),sizeof(address))==0){
        uint32_t length=htonl(bytes.size());std::string packet(reinterpret_cast<const char*>(&length),sizeof(length));packet+=bytes;
        size_t sent=0;
        while(sent<packet.size()){
          const auto remaining=base::span(packet).subspan(sent);
          int flags=0;
#if defined(MSG_NOSIGNAL)
          flags=MSG_NOSIGNAL;
#endif
          auto written=send(fd,remaining.data(),remaining.size(),flags);
          if(written<=0)break;sent+=written;
        }
      }
    }
    close(fd);
  }
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
  base::DictValue result;result.Set("type","VizScene");result.Set("captureId",id);
  result.Set("namespace",Numbers({double(ns.first),double(ns.second)}));
  base::ListValue passes;size_t count=0;std::string error;
  for(const auto& pass:frame.render_pass_list){
    base::DictValue output;output.Set("id",base::NumberToString(pass->id.GetUnsafeValue()));output.Set("output",Rect(pass->output_rect));
    base::ListValue quads;
    // Viz order is front to back. Keep it explicit; the Viewer reverses each
    // pass for painter's order and applies the actual quad clip/transform.
    for(const auto* quad:pass->quad_list){
      if(++count>2048){error="Viz quad budget exceeded";break;}
      const auto& sqs=*quad->shared_quad_state;
      if(!sqs.quad_to_target_transform.Is2dTransform() || sqs.sorting_context_id || !sqs.mask_filter_info.IsEmpty() || sqs.blend_mode!=SkBlendMode::kSrcOver){error="Unsupported Viz mask, 3D or blend";break;}
      base::DictValue q;q.Set("localId",static_cast<double>(sqs.layer_id));
      q.Set("namespace",Numbers({double(sqs.layer_namespace_id.first),double(sqs.layer_namespace_id.second)}));
      q.Set("matrix",Matrix(sqs.quad_to_target_transform));q.Set("visible",Rect(quad->visible_rect));q.Set("rect",Rect(quad->rect));
      q.Set("contentOrigin",Numbers({double(sqs.quad_layer_rect.x()),double(sqs.quad_layer_rect.y())}));
      q.Set("opacity",sqs.opacity);if(sqs.clip_rect)q.Set("clip",Rect(*sqs.clip_rect));
      q.Set("vizResource",static_cast<double>(quad->resource_id.GetUnsafeValue()));
      if(quad->material==viz::DrawQuad::Material::kSolidColor){
        q.Set("kind","solid");const auto color=viz::SolidColorDrawQuad::MaterialCast(quad)->color;
        q.Set("color",Numbers({color.fR,color.fG,color.fB,color.fA}));
      }else if(quad->material==viz::DrawQuad::Material::kAggregatedRenderPass){
        const auto* child=viz::AggregatedRenderPassDrawQuad::MaterialCast(quad);
        if(!child->filters.IsEmpty()||!child->backdrop_filters.IsEmpty()||child->resource_id!=viz::kInvalidResourceId){error="Unsupported Viz filtered/masked render pass";break;}
        q.Set("kind","pass");q.Set("passId",base::NumberToString(child->render_pass_id.GetUnsafeValue()));
      }else if(quad->material==viz::DrawQuad::Material::kTiledContent || quad->material==viz::DrawQuad::Material::kTextureContent || quad->material==viz::DrawQuad::Material::kPictureContent){q.Set("kind","picture");}
      else{error="Unsupported Viz quad material";break;}
      quads.Append(std::move(q));
    }
    output.Set("quads",std::move(quads));passes.Append(std::move(output));
    if(!error.empty())break;
  }
  result.Set("passes",std::move(passes));if(!error.empty())result.Set("error",error);
  auto bytes=base::WriteJson(result);
  if(!bytes||bytes->size()>256*1024){pending_writes.fetch_sub(1);return;}
  base::ThreadPool::PostTask(FROM_HERE,{base::MayBlock(),base::TaskPriority::USER_VISIBLE},base::BindOnce(&WriteScene,**endpoint,std::move(*bytes)));
}
}
