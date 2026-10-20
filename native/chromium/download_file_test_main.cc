// Real download filesystem/job tests; no browser or Skia initialization.
#include "base/test/test_suite.h"
#include "mojo/core/embedder/embedder.h"

int main(int argc, char** argv) {
  base::TestSuite suite(argc, argv);
  mojo::core::Init();
  return suite.Run();
}
