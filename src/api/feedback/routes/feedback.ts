// No public find/findOne/update/delete routes: messages are read in the admin UI.
export default {
  routes: [
    { method: "POST", path: "/feedback", handler: "feedback.create", config: { auth: false } },
    { method: "POST", path: "/feedback-delivery/claim", handler: "feedback.claim", config: { auth: false } },
    { method: "POST", path: "/feedback-delivery/complete", handler: "feedback.complete", config: { auth: false } },
  ],
};
