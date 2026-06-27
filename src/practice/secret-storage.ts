export interface SecretStorageLike {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

interface SecretStorageHost {
	secretStorage?: unknown;
}

export function getSecretSafely(
	app: SecretStorageHost,
	id: string
): string | null {
	const storage = getSecretStorage(app);
	if (!storage) return null;
	try {
		return storage.getSecret(id);
	} catch {
		return null;
	}
}

export function setSecretSafely(
	app: SecretStorageHost,
	id: string,
	secret: string
): boolean {
	const storage = getSecretStorage(app);
	if (!storage) return false;
	try {
		storage.setSecret(id, secret);
		return true;
	} catch {
		return false;
	}
}

function getSecretStorage(app: SecretStorageHost): SecretStorageLike | null {
	const storage = app.secretStorage;
	if (!storage || typeof storage !== "object") return null;
	const candidate = storage as Partial<SecretStorageLike>;
	const getSecret = candidate.getSecret;
	const setSecret = candidate.setSecret;
	if (
		typeof getSecret !== "function" ||
		typeof setSecret !== "function"
	) {
		return null;
	}
	return {
		getSecret: (id) => getSecret.call(storage, id),
		setSecret: (id, secret) => { setSecret.call(storage, id, secret); },
	};
}
