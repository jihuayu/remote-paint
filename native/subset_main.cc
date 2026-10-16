#include "components/remote_paint/serializer.h"
#include "components/remote_paint/font_subset.h"
#include <fstream>
#include <iostream>
#include <iomanip>
#include <optional>
#include <stdexcept>
#include <string>
#include <cstring>
#include "third_party/skia/include/core/SkCanvas.h"
#include "third_party/skia/include/core/SkFont.h"
#include "third_party/skia/include/core/SkImage.h"
#include "third_party/skia/include/core/SkPictureRecorder.h"
#include "third_party/skia/include/core/SkSerialProcs.h"
#include "third_party/skia/include/core/SkStream.h"
#include "third_party/skia/include/core/SkSurface.h"
#include "third_party/skia/include/core/SkTextBlob.h"
#include "third_party/skia/include/encode/SkPngEncoder.h"

namespace {
SkDeserialProcs DecodeProcs() {
  SkDeserialProcs procs;
  procs.fTypefaceStreamProc=[](SkStream& stream,void*){return SkTypeface::MakeDeserialize(&stream,remote_paint::FontManager());};
  procs.fImageProc=[](const void* data,size_t length,std::optional<SkAlphaType> alpha,void*){
    return SkImages::DeferredFromEncodedData(SkData::MakeWithCopy(data,length),alpha);
  };
  procs.fAllowSkSL=false;
  return procs;
}
void Write(const char* path,const SkData& data) {
  std::ofstream output(path,std::ios::binary);
  output.write(static_cast<const char*>(data.data()),data.size());
  if(!output)throw std::runtime_error("Cannot write native output");
}
void SelfTest() {
  auto face=remote_paint::FontManager()->matchFamilyStyle("Arial",SkFontStyle());
  if(!face)throw std::runtime_error("Arial unavailable");
  SkFont font(face,24);const std::string text="Native glyph IDs 0123456789";
  auto blob=SkTextBlob::MakeFromText(text.data(),text.size(),font);
  SkPictureRecorder recorder;auto* canvas=recorder.beginRecording(640,80);
  canvas->clear(SK_ColorWHITE);canvas->drawTextBlob(blob,4,36,SkPaint());
  auto original=recorder.finishRecordingAsPicture();
  auto encoded=remote_paint::SerializePicture(*original);
  if(!encoded.error.empty()||!encoded.bytes||encoded.fonts.size()!=1||
      encoded.fonts[0].subset_bytes>=encoded.fonts[0].original_bytes)throw std::runtime_error("Font subset invariant failed: "+encoded.error);
  if(encoded.asset_ranges.empty())throw std::runtime_error("Font byte range missing from SKP");
  // The same immutable font/image must be byte-identical when only drawing
  // commands change. This is the contract used by native asset manifests.
  auto image_surface=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(32,32));
  image_surface->getCanvas()->clear(SK_ColorBLUE);
  auto image=image_surface->makeImageSnapshot();
  auto make_assets=[&](int x){SkPictureRecorder r;auto* c=r.beginRecording(640,80);
    c->drawTextBlob(blob,x,36,SkPaint());c->drawImage(image,x,40);return remote_paint::SerializePicture(*r.finishRecordingAsPicture());};
  auto assets_a=make_assets(4),assets_b=make_assets(12);
  size_t shared_assets=0;
  for(const auto& a:assets_a.asset_ranges)for(const auto& b:assets_b.asset_ranges){
    if(a.kind==b.kind&&a.bytes==b.bytes&&!std::memcmp(static_cast<const char*>(assets_a.bytes->data())+a.offset,static_cast<const char*>(assets_b.bytes->data())+b.offset,a.bytes))shared_assets++;
  }
  if(!assets_a.error.empty()||!assets_b.error.empty()||shared_assets<2)throw std::runtime_error("Font/image blocks changed with drawing commands");
  auto procs=DecodeProcs();auto decoded=SkPicture::MakeFromData(encoded.bytes.get(),&procs);
  if(!decoded)throw std::runtime_error("Subset cannot deserialize");
  auto a=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640,80));
  auto b=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640,80));
  a->getCanvas()->drawPicture(original);b->getCanvas()->drawPicture(decoded);
  SkPixmap pa,pb;a->peekPixels(&pa);b->peekPixels(&pb);
  if(std::memcmp(pa.addr(),pb.addr(),pa.computeByteSize()))throw std::runtime_error("Subset changed glyph pixels");
  if(remote_paint::SerializePicture(*original,100).bytes)throw std::runtime_error("Budget was not enforced");
  std::cout<<"{\"nativeSelfTest\":\"passed\",\"glyphPixelsExact\":true,\"fontSubsetBytes\":"<<encoded.fonts[0].subset_bytes<<"}\n";
}
}

int main(int argc,char** argv) {
  try {
    if(argc==2&&std::string(argv[1])=="--self-test"){SelfTest();return 0;}
    if(argc<3||argc>4)throw std::runtime_error("Usage: skp_subset input.skp output.skp [replay.png] | --self-test");
    std::ifstream input(argv[1],std::ios::binary|std::ios::ate);
    const auto length=input.tellg();
    if(length<28||length>256*1024*1024)throw std::runtime_error("Invalid input size");
    input.seekg(0);std::string bytes(static_cast<size_t>(length),'\0');input.read(bytes.data(),bytes.size());
    auto procs=DecodeProcs();auto picture=SkPicture::MakeFromData(bytes.data(),bytes.size(),&procs);
    if(!picture)throw std::runtime_error("Cannot decode input SKP");
    auto result=remote_paint::SerializePicture(*picture);
    if(!result.bytes)throw std::runtime_error(result.error);
    Write(argv[2],*result.bytes);
    size_t changed_pixels=0;int max_error=0;
    if(argc==4){auto replay=SkPicture::MakeFromData(result.bytes.get(),&procs);if(!replay)throw std::runtime_error("Cannot decode serialized SKP");
      const auto cull=replay->cullRect();auto surface=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(cull.width(),cull.height()));
      auto reference=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(cull.width(),cull.height()));
      if(!surface||!reference)throw std::runtime_error("Cannot create replay surface");
      surface->getCanvas()->clear(SK_ColorWHITE);surface->getCanvas()->drawPicture(replay);
      reference->getCanvas()->clear(SK_ColorWHITE);reference->getCanvas()->drawPicture(picture);
      SkPixmap a,b;surface->peekPixels(&a);reference->peekPixels(&b);
      auto png=SkPngEncoder::Encode(nullptr,surface->makeImageSnapshot().get(),{});if(!png)throw std::runtime_error("Cannot encode replay PNG");Write(argv[3],*png);
      for(int y=0;y<a.height();y++)for(int x=0;x<a.width();x++){
        const auto* pa=static_cast<const unsigned char*>(a.addr(x,y));
        const auto* pb=static_cast<const unsigned char*>(b.addr(x,y));int delta=0;
        for(int c=0;c<4;c++)delta=std::max(delta,std::abs(int(pa[c])-int(pb[c])));
        if(delta)changed_pixels++;max_error=std::max(max_error,delta);
      }
      // CoreText may round a handful of edge coverages differently for a
      // subset font. Keep this separate from glyph IDs/positions and fail for
      // material differences; Arial self-test above remains byte-exact.
      if(max_error>16||changed_pixels>size_t(a.width())*a.height()/1000)
        throw std::runtime_error("Font subsetting exceeded native replay pixel budget: "+std::to_string(changed_pixels)+" pixels, max "+std::to_string(max_error));
    }
    std::cout<<"{\"inputBytes\":"<<bytes.size()<<",\"nativePixelsExact\":"<<(argc==4?(changed_pixels?"false":"true"):"null")<<",\"nativeChangedPixels\":"<<changed_pixels<<",\"nativeMaxChannelError\":"<<max_error<<",\"outputBytes\":"<<result.bytes->size()<<",\"imageBytes\":"<<result.image_bytes<<",\"imageCount\":"<<result.image_count<<",\"bitmapGlyphs\":"<<result.bitmap_glyphs<<",\"fonts\":[";
    bool first=true;
    for(const auto& font:result.fonts){if(!first)std::cout<<",";first=false;
      std::cout<<"{\"family\":"<<std::quoted(font.family)<<",\"glyphs\":"<<font.glyphs<<",\"missingGlyphs\":"<<font.missing_glyphs<<",\"originalBytes\":"<<font.original_bytes<<",\"subsetBytes\":"<<font.subset_bytes<<"}";}
    std::cout<<"]}\n";
    return 0;
  }catch(const std::exception& error){std::cerr<<error.what()<<"\n";return 1;}
}
