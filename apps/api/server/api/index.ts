import { defineHandler } from "nitro"
import { LINQ_ADAPTER_SENTINEL } from "@linq-chat-sdk/adapter-linq"

export default defineHandler((event) => {
  return { message: "Hello from API!", adapter: LINQ_ADAPTER_SENTINEL };
});
