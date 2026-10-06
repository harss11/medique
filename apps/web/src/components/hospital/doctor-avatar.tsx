import type { Doctor } from "@/lib/types";
import { cx } from "../ui";

/** Doctor photo, or initials when there is none. */
export function DoctorAvatar({
  doctor,
  size = "md",
}: {
  doctor: Pick<Doctor, "name" | "photoUrl">;
  size?: "md" | "lg";
}) {
  const box = size === "lg" ? "size-24 text-2xl" : "size-12 text-base";
  if (doctor.photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Cloudinary already serves resized images
      <img src={doctor.photoUrl} alt="" className={cx(box, "shrink-0 rounded-full object-cover")} />
    );
  }
  const initials = doctor.name
    .replace(/^dr\.?\s+/i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <div
      className={cx(
        box,
        "flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-800",
      )}
    >
      {initials}
    </div>
  );
}
