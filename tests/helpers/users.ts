import { createUser } from "../../apps/api/src/db/users.js";

/**
 * A throwaway user to hang rows off.
 *
 * `sessions.user_id` has a foreign key, so tests that fabricate a session need a
 * real user behind it - inserting one by hand here rather than in every test.
 */
let n = 0;
export function makeUser(role: "admin" | "user" = "user"): string {
  n += 1;
  return createUser({
    username: `test-user-${process.pid}-${n}`,
    displayName: `Test User ${n}`,
    role,
  }).id;
}
