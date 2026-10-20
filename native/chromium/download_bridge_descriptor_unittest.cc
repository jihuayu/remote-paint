#include "components/download/public/common/native_download_bridge_descriptor.h"

#include "base/command_line.h"
#include "base/test/scoped_command_line.h"
#include "base/unguessable_token.h"
#include "components/download/public/common/native_download_budget.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace {
using Descriptor = download::NativeDownloadBridgeDescriptor;
class RemotePaintDownloadBridgeTest : public testing::Test {
 protected:
  void SetUp() override {
    command_.GetProcessCommandLine()->AppendSwitchASCII("remote-paint-token", token_);
    command_.GetProcessCommandLine()->AppendSwitch("remote-paint-download-budget-v1");
  }
  const std::string token_ = std::string(32, 'a');
  const std::string document_ = base::UnguessableToken::Create().ToString();
  base::test::ScopedCommandLine command_;
};

TEST_F(RemotePaintDownloadBridgeTest, ActualTokenAndDocumentDescribeDiscoveryOnly) {
  Descriptor descriptor;
  const auto result = descriptor.Describe(token_, document_, document_, true, true);
  ASSERT_TRUE(result); EXPECT_EQ(1, result->descriptor_version);
  EXPECT_FALSE(result->transfers_ready); EXPECT_EQ(document_, result->document_token);
  EXPECT_EQ(download::NativeDownloadBudget::kMaxItems, static_cast<uint32_t>(result->max_items));
  EXPECT_EQ(download::NativeDownloadBudget::kFileBytes, static_cast<uint64_t>(result->max_file_bytes));
  EXPECT_EQ(0u, download::NativeDownloadBudget::ReservedItems());
}

TEST_F(RemotePaintDownloadBridgeTest, WrongOrUnboundedRequestCapabilityReturnsNoSnapshot) {
  Descriptor descriptor;
  for (const auto& token : {std::string(), std::string(31, 'a'), std::string(32, 'b'), std::string(257, 'a')})
    EXPECT_FALSE(descriptor.Describe(token, document_, document_, true, true));
  EXPECT_EQ(0u, download::NativeDownloadBudget::ReservedItems());
}

TEST_F(RemotePaintDownloadBridgeTest, BothExplicitProcessSwitchesAreRequired) {
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-download-budget-v1");
  Descriptor unstaged;
  EXPECT_FALSE(unstaged.Describe(token_, document_, document_, true, true));
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-download-budget-v1");
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
  Descriptor non_native;
  EXPECT_FALSE(non_native.Describe(token_, document_, document_, true, true));
}

TEST_F(RemotePaintDownloadBridgeTest, TrustAndActiveTopFrameWitnessesAreRequired) {
  Descriptor descriptor;
  EXPECT_FALSE(descriptor.Describe(token_, document_, document_, false, true));
  EXPECT_FALSE(descriptor.Describe(token_, document_, document_, true, false));
  EXPECT_FALSE(descriptor.Describe(token_, document_, document_, false, false));
}

TEST_F(RemotePaintDownloadBridgeTest, NewActualDocumentCannotRelabelOldExpectedDocument) {
  Descriptor descriptor;
  const std::string next = base::UnguessableToken::Create().ToString();
  ASSERT_NE(document_, next);
  const auto original = descriptor.Describe(token_, document_, document_, true, true);
  ASSERT_TRUE(original);
  EXPECT_FALSE(descriptor.Describe(token_, document_, next, true, true));
  const auto current = descriptor.Describe(token_, next, next, true, true);
  ASSERT_TRUE(current); EXPECT_EQ(next, current->document_token);
  EXPECT_EQ(document_, original->document_token);
}

TEST_F(RemotePaintDownloadBridgeTest, EmptyOrOversizedDocumentReturnsNoSnapshot) {
  Descriptor descriptor;
  EXPECT_FALSE(descriptor.Describe(token_, "", "", true, true));
  EXPECT_FALSE(descriptor.Describe(token_, document_, "", true, true));
  const std::string large(65, 'x');
  EXPECT_FALSE(descriptor.Describe(token_, large, large, true, true));
}

TEST_F(RemotePaintDownloadBridgeTest, ProcessPolicyAndCapabilityAreConstructorSnapshots) {
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-download-budget-v1");
  Descriptor disabled;
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-download-budget-v1");
  Descriptor original;
  EXPECT_FALSE(disabled.Describe(token_, document_, document_, true, true));
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
  command_.GetProcessCommandLine()->AppendSwitchASCII("remote-paint-token", std::string(32, 'b'));
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-download-budget-v1");
  EXPECT_TRUE(original.Describe(token_, document_, document_, true, true));
  EXPECT_FALSE(original.Describe(std::string(32, 'b'), document_, document_, true, true));
  Descriptor later;
  EXPECT_FALSE(later.Describe(std::string(32, 'b'), document_, document_, true, true));
}

TEST_F(RemotePaintDownloadBridgeTest, InvalidConfiguredCapabilityNeverAuthorizesItself) {
  for (const auto& token : {std::string(), std::string(31, 'a'), std::string(257, 'a')}) {
    command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
    command_.GetProcessCommandLine()->AppendSwitchASCII("remote-paint-token", token);
    Descriptor descriptor;
    EXPECT_FALSE(descriptor.Describe(token, document_, document_, true, true));
  }
}
}  // namespace
