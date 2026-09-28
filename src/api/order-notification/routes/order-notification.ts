export default {
  routes: [
    { method: "POST", path: "/feedback-delivery/order-claim", handler: "order-notification.claim", config: { auth: false } },
    { method: "POST", path: "/feedback-delivery/order-complete", handler: "order-notification.complete", config: { auth: false } },
  ],
};
