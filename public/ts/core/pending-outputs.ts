// The outputs whose Start or Stop button was just clicked. The button stays disabled
// from the click until the operation, and the refresh that follows it, has finished, so
// a second click cannot land before the card shows the new state. It ends however the
// operation ends: a start the server refuses or a connection that is down changes
// nothing in the config, and waiting for a state that never comes left the button
// disabled until the page was reloaded.

export type PendingOutputs = Set<string>;

// `onEnd` draws the list again once the output is no longer pending. An error from
// `operation` is not swallowed: it is rethrown after the output is released.
export async function whilePending(
    pending: PendingOutputs,
    outputId: string,
    operation: () => Promise<unknown>,
    onEnd: () => void,
): Promise<void> {
    pending.add(outputId);
    try {
        await operation();
    } finally {
        pending.delete(outputId);
        onEnd();
    }
}
