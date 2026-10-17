// Pure pose logic for Oshabe's character, shared by the persistent Sidebar
// instance and the onboarding wizard.

export type Pose = "idle" | "busy" | "presenting" | "listening" | "happy";

export function isAppBusy(
  downloading: Record<string, true>,
  verifying: Record<string, true>,
  extracting: Record<string, true>,
): boolean {
  return (
    Object.keys(downloading).length > 0 ||
    Object.keys(verifying).length > 0 ||
    Object.keys(extracting).length > 0
  );
}
