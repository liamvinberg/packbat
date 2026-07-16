import { runInitWizardWorkflow } from "../core/init-wizard.js";
import { runDoctor } from "./doctor.js";
import { runSync } from "./sync.js";

export async function runInitWizard(options: { activateSchedule: boolean }): Promise<number> {
	return await runInitWizardWorkflow(options, {
		doctor: async () => await runDoctor([]),
		sync: async (output) => await runSync([], output),
	});
}
