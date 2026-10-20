#ifndef COMPONENTS_REMOTE_PAINT_VIZ_CAPTURE_H_
#define COMPONENTS_REMOTE_PAINT_VIZ_CAPTURE_H_
#include <string>
#include <cstdint>
#include <utility>
namespace viz {class AggregatedFrame;}
namespace remote_paint {
void EmitVizScene(const viz::AggregatedFrame& frame,const std::string& capture_id,
                  std::pair<uint32_t,uint32_t> producer_namespace,
                  uint32_t frame_token);
}
#endif
