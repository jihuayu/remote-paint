// Real download filesystem/job tests; no browser or Skia initialization.
#include "base/test/test_suite.h"
#include "mojo/core/embedder/embedder.h"
#include "base/threading/thread.h"
#include "components/download/public/common/download_task_runner.h"

int main(int argc, char** argv) {
  base::TestSuite suite(argc, argv);
  mojo::core::Init();
  base::Thread io("download-test-io");
  base::Thread::Options options;
  options.message_pump_type = base::MessagePumpType::IO;
  if (!io.StartWithOptions(std::move(options))) return 1;
  download::SetIOTaskRunner(io.task_runner());
  const int result = suite.Run();
  io.Stop();
  return result;
}
