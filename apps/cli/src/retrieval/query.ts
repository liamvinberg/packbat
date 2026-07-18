import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { errorMessage, PackbatError } from "../core/errors.js";

export interface RetrievalQueryResult {
	columns: string[];
	rows: unknown[][];
	truncated: boolean;
}

function openReadOnly(path: string): DatabaseSync {
	const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
	return new sqlite.DatabaseSync(path, { readOnly: true });
}

export function queryRetrieval(path: string, sql: string): RetrievalQueryResult {
	const database = openReadOnly(path);
	try {
		try {
			const statement = database.prepare(`SELECT * FROM (\n${sql}\n) LIMIT 201`);
			const columns = statement.columns().map((column) => column.name);
			const records = statement.all() as Record<string, unknown>[];
			const truncated = records.length > 200;
			return {
				columns,
				rows: records.slice(0, 200).map((record) => columns.map((column) => record[column])),
				truncated,
			};
		} catch (error) {
			// DRAFT copy
			throw new PackbatError(`invalid query: ${errorMessage(error)}`);
		}
	} finally {
		database.close();
	}
}
