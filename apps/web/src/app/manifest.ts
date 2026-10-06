import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MediQ: Doctor Appointments",
    short_name: "MediQ",
    description: "Book a doctor, pay online and get your token number instantly.",
    id: "/",
    lang: "en-IN",
    start_url: "/",
    scope: "/",
    categories: ["medical", "health"],
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0f766e",
    shortcuts: [
      { name: "Find a hospital", short_name: "Hospitals", url: "/hospitals" },
      { name: "My appointments", short_name: "Appointments", url: "/patient/appointments" },
      { name: "Emergency help", short_name: "Emergency", url: "/emergency" },
    ],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
