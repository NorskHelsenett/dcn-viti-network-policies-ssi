import { simpleGit, SimpleGitOptions } from "simple-git";
import logger from "../loggers/logger.ts";

export const initializeGitRepository = async (
  gitOptions: Partial<SimpleGitOptions>,
  targetBranch: string,
  repoPath: string,
) => {
  try {
    logger.info("viti-network-policies-ssi: Initializing Git repository...");
    await Deno.mkdir(gitOptions.baseDir as string);
    const git = simpleGit(gitOptions);
    await git.clone(repoPath, gitOptions.baseDir as string);
    await git.fetch();
    const branches = await git.branch();

    // Check if the branch exists locally or remotely
    if (
      !branches.all.includes(targetBranch) &&
      !branches.all.includes(`remotes/origin/${targetBranch}`)
    ) {
      logger.info(
        `viti-network-policies-ssi: Creating new branch '${targetBranch}'`,
      );
      await git.checkoutLocalBranch(targetBranch);
    } else {
      logger.info(
        `viti-network-policies-ssi: Checking out existing branch '${targetBranch}'`,
      );
      await git.checkout(targetBranch);
      await git.pull("origin", targetBranch);
    }
  } catch (error) {
    throw error;
  }
};
