export interface MachineRemote {
	createdAt: number;
	id: string;
}

export interface MachineObject {
	key: string;
	size: number;
}

export interface MachineObjectPage {
	cursor?: string;
	objects: MachineObject[];
}

const OBJECT_PAGE_SIZE = 1_000;

export async function listMachineRemotes(binding: D1Database, userId: string): Promise<MachineRemote[]> {
	const machines = await binding
		.prepare(
			`SELECT id, created_at AS createdAt
			FROM machine_remotes
			WHERE user_id = ?
			ORDER BY created_at, id`,
		)
		.bind(userId)
		.all<MachineRemote>();
	return machines.results;
}

export async function listMachineObjects(
	binding: D1Database,
	userId: string,
	machineRemoteId: string,
	cursor?: string,
): Promise<MachineObjectPage | null> {
	const machine = await binding
		.prepare("SELECT id FROM machine_remotes WHERE user_id = ? AND id = ?")
		.bind(userId, machineRemoteId)
		.first<{ id: string }>();
	if (machine === null) {
		return null;
	}

	const page = await binding
		.prepare(
			`SELECT logical_object_key AS key, bytes AS size
			FROM object_ledger
			WHERE user_id = ? AND machine_remote_id = ? AND logical_object_key > ?
			ORDER BY logical_object_key
			LIMIT ?`,
		)
		.bind(userId, machineRemoteId, cursor ?? "", OBJECT_PAGE_SIZE + 1)
		.all<MachineObject>();
	const objects = page.results.slice(0, OBJECT_PAGE_SIZE);
	if (page.results.length <= OBJECT_PAGE_SIZE) {
		return { objects };
	}
	const nextCursor = objects.at(-1)?.key;
	if (nextCursor === undefined) {
		throw new Error("machine object page has no cursor candidate");
	}
	return { cursor: nextCursor, objects };
}
