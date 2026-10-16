#ifndef COMPONENTS_REMOTE_PAINT_SERIALIZER_H_
#define COMPONENTS_REMOTE_PAINT_SERIALIZER_H_

#include <cstddef>
#include <string>
#include <vector>

#include "third_party/skia/include/core/SkData.h"
#include "third_party/skia/include/core/SkPicture.h"

namespace remote_paint {

struct FontStats {
  std::string family;
  size_t glyphs = 0;
  size_t original_bytes = 0;
  size_t subset_bytes = 0;
  size_t missing_glyphs = 0;
};

struct SerializedPicture {
  sk_sp<const SkData> bytes;
  std::vector<FontStats> fonts;
  size_t image_bytes = 0;
  size_t image_count = 0;
  size_t bitmap_glyphs = 0;
  bool requires_isolation = false;
  double portable_ms = 0;
  double glyph_collection_ms = 0;
  double serialize_ms = 0;
  double font_ms = 0;
  double image_ms = 0;
  std::string error;
};

// Input must contain immutable software-backed images. No DOM, Layer, canvas or
// GPU-context pointers cross into this function; it may run on a worker thread.
// Every result is a complete independently replayable picture, including fonts.
SerializedPicture SerializePicture(const SkPicture& picture,
                                   size_t byte_budget = 16 * 1024 * 1024);

}  // namespace remote_paint
#endif
