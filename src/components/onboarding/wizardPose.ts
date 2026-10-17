import type { Pose } from "../character/pose";
import type { Step } from "./SetupWizard";

export interface WizardPoseSignals {
  practiceHasText: boolean;
  isDownloading: boolean;
  justFinished: boolean;
}

export function poseForStep(step: Step, signals: WizardPoseSignals): Pose {
  switch (step) {
    case "purpose":
      return "presenting";
    case "languages":
      return "idle";
    case "quality":
      return signals.isDownloading ? "busy" : "presenting";
    case "practice":
      return "listening";
    case "cleanup":
      return signals.justFinished ? "happy" : "idle";
    case "advanced":
      return "idle";
  }
}
