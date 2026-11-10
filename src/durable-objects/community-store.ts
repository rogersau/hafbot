export class CommunityStoreDO implements DurableObject {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {}
}
