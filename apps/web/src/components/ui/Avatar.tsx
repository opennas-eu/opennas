import { clsx } from "clsx";
import { apiUrl } from "../../lib/api.ts";
import { initialsOf } from "../../lib/format.ts";

interface AvatarUser {
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
}

/**
 * A user's profile picture when one is uploaded, otherwise a colored circle with
 * their initials. `className` controls the size (set both height and width).
 */
export function Avatar({
  user,
  className,
}: {
  user: AvatarUser;
  className?: string;
}) {
  const base = clsx("shrink-0 overflow-hidden rounded-full object-cover", className);
  if (user.avatarUrl) {
    return <img src={apiUrl(user.avatarUrl)} alt={user.displayName} className={base} />;
  }
  return (
    <span
      className={clsx(base, "grid place-items-center font-semibold text-white")}
      style={{ backgroundColor: user.avatarColor }}
      aria-label={user.displayName}
    >
      {initialsOf(user.displayName)}
    </span>
  );
}
