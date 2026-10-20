// Real BaseFile filesystem tests; no browser, network or Skia initialization.
#include "base/test/test_suite.h"

int main(int argc, char** argv) {
  base::TestSuite suite(argc, argv);
  return suite.Run();
}
