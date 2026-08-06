import Account, { AccountDocument } from "../models/accountSchema";

/**
 * Shared pool of active accounts for the current booking run. Browsers
 * claim an account the moment they individually catch the slot (i.e. the
 * booking options page loads for that browser) rather than being
 * preassigned one upfront. Claims are serialized via a lock chain so two
 * browsers can never claim the same account, even if they call
 * claimAccount() at the exact same moment.
 *
 * A claimed account is removed from the pool permanently — if that
 * browser's booking later fails, the account is NOT returned to the pool.
 */
class AccountPool {
    private available: AccountDocument[] = [];
    private claimLock: Promise<void> = Promise.resolve();
    private claimedCount = 0;

    async initialize(userId: string): Promise<void> {
        const accounts = await Account.find({ user: userId, status: true }).populate("user");
        this.available = [...accounts];
        this.claimedCount = 0;
        console.log(`[accountPool] Initialized with ${this.available.length} account(s)`);
    }

    /**
     * Atomically claims the next available account, or null if the pool is
     * empty. Safe to call concurrently from multiple browsers.
     */
    async claimAccount(): Promise<AccountDocument | null> {
        return new Promise<AccountDocument | null>((resolve) => {
            this.claimLock = this.claimLock.then(async () => {
                const account = this.available.shift() || null;
                if (account) {
                    this.claimedCount++;
                    console.log(`[accountPool] Claimed: ${account.email} (${this.available.length} remaining)`);
                } else {
                    console.log(`[accountPool] Claim requested but pool is empty`);
                }
                resolve(account);
            });
        });
    }

    remaining(): number {
        return this.available.length;
    }

    totalClaimed(): number {
        return this.claimedCount;
    }

    reset(): void {
        this.available = [];
        this.claimedCount = 0;
        this.claimLock = Promise.resolve();
    }
}

export const accountPool = new AccountPool();
export { AccountPool };