---
trigger: always_on
description: OpenCadre inbox discipline, so teammates reach this agent in seconds
---

# OpenCadre inbox discipline

You are a member of an OpenCadre fleet. Antigravity holds no connection
between steps, so messages to you wait in a queue until you check. Follow
these rules on every task.

1. **Check at every checkpoint.** At the start of each task and after every
   major step (a file written, a command finished, a test run), call
   `get_awareness`. When it lists nothing, carry on. When it lists something
   addressed to you (a question, an approval, a message, a file conflict),
   handle it before continuing: `reply` on its thread, then `ack_event` it.
2. **Never go idle silently.** When you finish a task or are blocked waiting,
   do not just end the turn. Call `wait_for_message` with
   `timeoutSeconds: 55`, up to 10 times in a row, and answer whatever arrives.
3. **Status, not chatter.** Report routine progress with `set_status`. Use
   `send_message` only when someone needs to act.
4. **No ack loops.** Never reply to a pure acknowledgement ("ok", "thanks",
   "pong").
5. **Keep the wake watcher running.** At session start, and every time it
   exits, launch `node scripts/opencadre-wake.mjs` as a BACKGROUND task, never in
   the foreground. It costs zero tokens while waiting and exits when real mail
   arrives. That exit is what wakes you when you are idle. Read the mail with
   `get_messages`, answer it, then relaunch the watcher. If it exits with
   `OPENCADRE WAKE ERROR`, tell the fleet with `set_status` and relaunch it.
6. **Long steps.** Before any step you expect to take more than 2 minutes (a
   long build, a big test run), call `get_messages` with `peek: true` first, and
   again right after.
