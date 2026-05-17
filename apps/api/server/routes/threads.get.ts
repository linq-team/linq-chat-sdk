import { defineHandler } from "nitro"

export default defineHandler(() => {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/threads.html",
    },
  })
})
