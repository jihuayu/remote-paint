// The serializer tests only need process globals, Skia and Google Test. They do
// not use browser test clients, resource bundles, task environments or tracing.
#include "base/at_exit.h"
#include "base/command_line.h"
#include "base/test/test_discardable_memory_allocator.h"
#include "skia/ext/font_utils.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/core/SkGraphics.h"

int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  SkGraphics::Init();
  base::TestDiscardableMemoryAllocator allocator;
  base::DiscardableMemoryAllocator::SetInstance(&allocator);
  skia::InitializeFontRendering();
  testing::InitGoogleTest(&argc, argv);
  const int result=RUN_ALL_TESTS();
  base::DiscardableMemoryAllocator::SetInstance(nullptr);
  return result;
}
