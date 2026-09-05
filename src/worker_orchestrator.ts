import type { BlueprintStage, DAGPlanResult } from "./types.js";
import { planDAGWaves } from "./engine.js";

export interface ParallelTaskUnit {
  laneId: string;
  stageId: string;
  stageTitle: string;
  targetArtifacts: string[];
  executionPrompt: string;
}

export interface WaveExecutionBundle {
  waveIndex: number;
  isParallel: boolean;
  tasks: ParallelTaskUnit[];
}

export class MultiAgentWorkerOrchestrator {
  public static compileWaveBundles(stages: BlueprintStage[], maxConcurrency: number = 4): WaveExecutionBundle[] {
    const dagResult: DAGPlanResult = planDAGWaves(stages);
    const bundles: WaveExecutionBundle[] = [];
    let bundleIdx = 1;
    const limit = Math.max(1, maxConcurrency);

    for (const wave of dagResult.waves) {
      const stageChunks: BlueprintStage[][] = [];
      for (let i = 0; i < wave.stages.length; i += limit) {
        stageChunks.push(wave.stages.slice(i, i + limit));
      }

      for (const chunk of stageChunks) {
        const isParallel = chunk.length > 1;
        const tasks: ParallelTaskUnit[] = chunk.map((s, subIdx) => {
          const artifacts =
            s.expectedArtifacts && s.expectedArtifacts.length > 0
              ? s.expectedArtifacts
              : s.expectedArtifact
              ? [s.expectedArtifact]
              : [];
          const desc = s.coreObjective || s.title;
          return {
            laneId: "wave_" + bundleIdx + "_lane_" + (subIdx + 1),
            stageId: s.stageId,
            stageTitle: s.title,
            targetArtifacts: artifacts,
            executionPrompt: "[Stage: " + s.title + "] " + desc + " -> 交付产物: " + artifacts.join(", ")
          };
        });

        bundles.push({
          waveIndex: bundleIdx++,
          isParallel,
          tasks
        });
      }
    }

    return bundles;
  }
}
