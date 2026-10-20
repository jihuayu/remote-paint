#ifndef COMPONENTS_REMOTE_PAINT_ENCODED_PICTURE_H_
#define COMPONENTS_REMOTE_PAINT_ENCODED_PICTURE_H_
#include <cstddef>
#include <limits>
#include <string>
#include "components/remote_paint/serializer.h"

namespace remote_paint {
struct EncodedPicture {
  SerializedPicture serialized;
  std::string base64;
  std::string resource_id;
};

// Retained generated SKP bytes and owned metadata capacities. This is a
// conservative cache-owner charge, not a measurement of physical heap/RSS.
inline size_t EncodedPictureRetainedBytes(const EncodedPicture& picture) {
  size_t bytes = sizeof(EncodedPicture) + 64;  // SkData/control allocation.
  const auto add = [&](size_t count, size_t width = 1) {
    if (count > (std::numeric_limits<size_t>::max() - bytes) / width)
      bytes = std::numeric_limits<size_t>::max();
    else bytes += count * width;
  };
  if (picture.serialized.bytes) add(picture.serialized.bytes->size());
  add(picture.base64.capacity()); add(1);
  add(picture.resource_id.capacity()); add(1);
  add(picture.serialized.error.capacity()); add(1);
  add(picture.serialized.fonts.capacity(), sizeof(FontStats));
  for (const auto& font : picture.serialized.fonts) { add(font.family.capacity()); add(1); }
  add(picture.serialized.asset_ranges.capacity(), sizeof(AssetRange));
  for (const auto& range : picture.serialized.asset_ranges) { add(range.kind.capacity()); add(1); }
  return bytes;
}
}  // namespace remote_paint
#endif
