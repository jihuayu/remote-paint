#ifndef COMPONENTS_REMOTE_PAINT_CANVAS_CAPTURE_H_
#define COMPONENTS_REMOTE_PAINT_CANVAS_CAPTURE_H_
#include <array>
#include <cstddef>
#include <memory>
#include <string>
#include "third_party/skia/include/core/SkColor.h"
#include "third_party/skia/include/core/SkData.h"
#include "third_party/skia/include/core/SkImage.h"
#include "third_party/skia/include/core/SkPicture.h"
#include "third_party/skia/include/core/SkPixmap.h"

namespace remote_paint {
inline constexpr char kCanvasPixelPressure[]="Canvas pixel allocation budget exceeded";
class CanvasPixelPool {
 public:
  struct Stats {size_t bytes,peak,limit,owners,denied;};
  explicit CanvasPixelPool(size_t limit);
  ~CanvasPixelPool();
  std::shared_ptr<void> Reserve(size_t bytes,std::string* error);
  Stats stats() const;
 private:
  struct State;
  std::shared_ptr<State> state_;
};
CanvasPixelPool& GetCanvasPixelPool();
// Same8192-dimension/64MiB decoded-image bound as the existing serializer.
bool CanvasPixelSize(int width,int height,size_t* bytes);
// Pixel memory is allocated after admission. Its SkData release procedure
// returns credit only after the actual pixel owner is destroyed.
sk_sp<SkData> AllocateCanvasPixels(CanvasPixelPool& pool,size_t bytes,std::string* error);
bool CopyCanvasPixmap(const SkPixmap& source,const SkImageInfo& destination,
                      SkData* pixels,std::string* error);
// Native layer geometry/UV are baked into a CPU-only picture. Viz continues
// to own matrix,clip,rounded clip,opacity and order on the matching frame.
sk_sp<SkPicture> CanvasPicture(sk_sp<SkImage> image,int width,int height,
    const std::array<float,4>& uv,bool flip_y,bool nearest,
    SkColor4f background,std::string* error);
}
#endif
