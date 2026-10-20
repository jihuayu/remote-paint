// Context payload contracts, not real RFH/navigation runtime acceptance.
#include "components/download/public/common/native_download_request_context.h"
#include "base/command_line.h"
#include "base/test/scoped_command_line.h"
#include "components/download/public/common/download_create_info.h"
#include "components/download/public/common/download_url_parameters.h"
#include "net/traffic_annotation/network_traffic_annotation_test_helper.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace {
using Context = download::NativeDownloadRequestContext;
Context::Frame Frame(int process = 1, int routing = 2) {
  return {process, routing, base::UnguessableToken::Create().ToString()};
}
class RemotePaintDownloadContextTest : public testing::Test {
 protected:
  void SetUp() override {
    command_.GetProcessCommandLine()->AppendSwitch("remote-paint-token");
    command_.GetProcessCommandLine()->AppendSwitch("remote-paint-download-budget-v1");
  }
  scoped_refptr<Context> Make(Context::Frame page) {
    return Context::Create(Context::Origin::kRendererNavigation, Frame(), Frame(), std::move(page));
  }
  base::test::ScopedCommandLine command_;
};
TEST_F(RemotePaintDownloadContextTest, ImmutableCopyAndDistinctAttemptIdentity) {
  auto page = Frame(); const auto original = page;
  auto first = Make(page), second = Make(page); ASSERT_TRUE(first); ASSERT_TRUE(second);
  EXPECT_NE(first->request_id(), second->request_id()); EXPECT_FALSE(first->request_id().is_empty());
  page.document_token.clear(); page.process_id = -1;
  EXPECT_EQ(original.document_token, first->page().document_token);
  EXPECT_EQ(original.process_id, first->page().process_id);
}
TEST_F(RemotePaintDownloadContextTest, AllSupportedBrowserEntryKindsAreExplicit) {
  for (auto origin : {Context::Origin::kBrowserNavigation, Context::Origin::kRendererNavigation, Context::Origin::kExplicitRequest}) {
    auto context = Context::Create(origin, Frame(), Frame(), Frame()); ASSERT_TRUE(context);
    EXPECT_EQ(origin, context->origin());
  }
  EXPECT_FALSE(Context::Create(static_cast<Context::Origin>(99), Frame(), Frame(), Frame()));
}
TEST_F(RemotePaintDownloadContextTest, InvalidFrameOrUnboundedDocumentIsUnknown) {
  for (int position = 0; position < 3; ++position) {
    for (int invalid = 0; invalid < 4; ++invalid) {
      auto target = Frame(), initiator = Frame(), page = Frame();
      auto* changed = position == 0 ? &target : position == 1 ? &initiator : &page;
      if (invalid == 0) changed->process_id = -1;
      if (invalid == 1) changed->routing_id = -1;
      if (invalid == 2) changed->document_token.clear();
      if (invalid == 3) changed->document_token.assign(65, 'x');
      EXPECT_FALSE(Context::Create(Context::Origin::kExplicitRequest, target, initiator, page));
    }
  }
}
TEST_F(RemotePaintDownloadContextTest, PageMatchingIncludesProcessRoutingAndDocument) {
  const auto page = Frame(); auto first = Make(page), second = Make(page);
  ASSERT_TRUE(first); ASSERT_TRUE(second); EXPECT_TRUE(first->SamePageDocument(*second));
  for (int field = 0; field < 3; ++field) {
    auto other = page;
    if (field == 0) ++other.process_id;
    if (field == 1) ++other.routing_id;
    if (field == 2) other.document_token = base::UnguessableToken::Create().ToString();
    auto changed = Make(other); ASSERT_TRUE(changed); EXPECT_FALSE(first->SamePageDocument(*changed));
  }
}
TEST_F(RemotePaintDownloadContextTest, BothStagedSwitchesRequiredForNewCapture) {
  auto original = Make(Frame()); ASSERT_TRUE(original);
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-download-budget-v1");
  EXPECT_FALSE(Make(Frame())); EXPECT_FALSE(original->page().document_token.empty());
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-download-budget-v1");
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token"); EXPECT_FALSE(Make(Frame()));
}
TEST_F(RemotePaintDownloadContextTest, ActualParameterAndInfoOwnershipKeepSameSnapshot) {
  auto context = Make(Frame()); ASSERT_TRUE(context); const auto id = context->request_id();
  auto params = std::make_unique<download::DownloadUrlParameters>(GURL("https://example.test/file"), TRAFFIC_ANNOTATION_FOR_TESTS);
  params->remote_paint_request_context = context;
  auto info = std::make_unique<download::DownloadCreateInfo>();
  info->remote_paint_request_context = params->remote_paint_request_context;
  context.reset(); params.reset(); EXPECT_EQ(id, info->remote_paint_request_context->request_id());
}
}  // namespace
