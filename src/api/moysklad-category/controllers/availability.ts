import { availabilityEnabled, getAvailabilitySnapshot } from "../../../utils/availability-job";

export default {
  async find(ctx: any) {
    const snapshot = await getAvailabilitySnapshot(strapi);
    if (availabilityEnabled() && !snapshot.updatedAt) {
      ctx.status = 503;
      ctx.set("Cache-Control", "no-store");
      ctx.body = { error: "availability_not_ready" };
      return;
    }
    ctx.set("Cache-Control", "public, max-age=60");
    ctx.body = snapshot;
  },
};
