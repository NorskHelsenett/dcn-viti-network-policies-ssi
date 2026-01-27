import { simpleGit, SimpleGitOptions } from "simple-git";

export const prepareGitRepo = async (
  gitOptions: Partial<SimpleGitOptions>,
  branchName: string,
  repoUrlWithKey: string,
) => {
  try {
    console.log("Preparing Git repo at:", gitOptions);
    await Deno.mkdir(gitOptions.baseDir as string);
    const git = simpleGit(gitOptions);
    await git.clone(repoUrlWithKey, gitOptions.baseDir as string);
    // const branchSummary = await git.fetch();
    await git.fetch();
    const branches = await git.branch();

    // Check if the branch exists locally or remotely
    if (
      !branches.all.includes(branchName) &&
      !branches.all.includes(`remotes/origin/${branchName}`)
    ) {
      console.log("Creating new branch:", branchName);
      await git.checkoutLocalBranch(branchName);
    } else {
      console.log("Checking out existing branch:", branchName);
      await git.checkout(branchName);
      await git.pull("origin", branchName);
    }
  } catch (error) {
    console.log("Error preparing Git repo:", error);
  }
};
