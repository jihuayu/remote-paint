#include "components/remote_paint/viz_delivery.h"

namespace remote_paint {
VizDeliveryQueue::VizDeliveryQueue(size_t capacity, size_t history)
    : capacity_(capacity), history_limit_(history) {
  assert(capacity_ > 0 && history_limit_ > 0);
}
VizDeliveryQueue::~VizDeliveryQueue() = default;
}  // namespace remote_paint
