import type { OshiState } from "../../character/oshi3d";
import type { Step } from "./SetupWizard";

export interface WizardPoseSignals {
  practiceHasText: boolean;
  isDownloading: boolean;
  justFinished: boolean;
}

export function poseForStep(step: Step, signals: WizardPoseSignals): OshiState {
  switch (step) {
    case "purpose":
      return "happy";
    case "languages":
      return "idle";
    case "quality":
      return signals.isDownloading ? "thinking" : "happy";
    case "practice":
      return "listening";
    case "cleanup":
      return signals.justFinished ? "happy" : "idle";
    case "advanced":
      return "idle";
  }
}
