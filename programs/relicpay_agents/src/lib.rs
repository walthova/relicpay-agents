//! RelicPay Agents: AI agents that buy now, pay later on their owner's
//! behalf, inside rules the owner writes on-chain.
//!
//! THE MODEL (devnet, mock USDC, not audited):
//!   - Owner deposits collateral into a CreditVault. Credit line = 80% LTV.
//!   - Owner writes a Mandate for one agent key: total budget, per-purchase
//!     cap, up to 5 approved merchants, expiry. Owner can revoke in one tap.
//!   - The agent calls `agent_purchase` with ONLY its own key. The program
//!     checks every rule, the Pool pays the merchant up front, and an
//!     Agreement records the owner's debt.
//!   - Owner repays the Pool. Each fully repaid agreement adds to the
//!     owner's on-chain trust record.
//!
//! The agent key can never move collateral, change its own limits, or
//! revoke/un-revoke a mandate: every one of those requires the owner's
//! signature. A hacked or confused agent can at most spend what the mandate
//! still allows, at merchants the owner approved.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("HwMQv76mcuPCMmoW3APdn3ceqikHWoWRq1YVy5n3PurH");

// ─── Constants ───────────────────────────────────────────────────────────────

pub const SEED_POOL: &[u8] = b"pool";
pub const SEED_MOCK_USDC: &[u8] = b"mock_usdc";
pub const SEED_LIQUIDITY: &[u8] = b"liquidity";
pub const SEED_COLLATERAL: &[u8] = b"collateral";
pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_MANDATE: &[u8] = b"mandate";
pub const SEED_AGREEMENT: &[u8] = b"agreement";

/// Credit line = 80% of collateral.
pub const LTV_BPS: u64 = 8_000;
pub const BPS: u64 = 10_000;
pub const MAX_MERCHANTS: usize = 5;
pub const MAX_REASON_LEN: usize = 64;
pub const USDC_DECIMALS: u8 = 6;
/// Mock USDC the pool starts with (1,000,000 USDC).
pub const POOL_STARTING_LIQUIDITY: u64 = 1_000_000 * 1_000_000;
/// Most mock USDC one faucet call can mint (1,000 USDC).
pub const FAUCET_MAX: u64 = 1_000 * 1_000_000;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_REPAID: u8 = 1;

/// 80% of collateral, with checked math.
pub fn credit_line(collateral: u64) -> Result<u64> {
    let line = (collateral as u128)
        .checked_mul(LTV_BPS as u128)
        .ok_or(RelicError::MathOverflow)?
        / BPS as u128;
    Ok(line as u64)
}

#[program]
pub mod relicpay_agents {
    use super::*;

    /// Creates the Pool, the mock USDC mint, and the pool's liquidity and
    /// collateral token accounts, then seeds the pool with mock USDC.
    /// Only the program's upgrade authority (the deployer) may call it.
    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.mint = ctx.accounts.mint.key();
        pool.total_lent = 0;
        pool.total_repaid = 0;
        pool.bump = ctx.bumps.pool;

        let seeds: &[&[u8]] = &[SEED_POOL, &[pool.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.liquidity.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            POOL_STARTING_LIQUIDITY,
        )?;
        Ok(())
    }

    /// Devnet-only mock USDC faucet so anyone can try the demo.
    pub fn faucet(ctx: Context<Faucet>, amount: u64) -> Result<()> {
        require!(amount > 0 && amount <= FAUCET_MAX, RelicError::FaucetLimit);
        let seeds: &[&[u8]] = &[SEED_POOL, &[ctx.accounts.pool.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    /// Owner locks mock USDC as collateral. Credit line = 80% of it.
    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, RelicError::InvalidAmount);
        let vault = &mut ctx.accounts.vault;
        if vault.owner == Pubkey::default() {
            vault.owner = ctx.accounts.owner.key();
            vault.bump = ctx.bumps.vault;
        }
        vault.collateral = vault
            .collateral
            .checked_add(amount)
            .ok_or(RelicError::MathOverflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_usdc.to_account_info(),
                    to: ctx.accounts.collateral.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(CollateralDeposited {
            owner: vault.owner,
            amount,
            collateral: vault.collateral,
            credit_line: credit_line(vault.collateral)?,
        });
        Ok(())
    }

    /// Owner takes collateral back, as long as the remaining collateral
    /// still covers their debt at 80% LTV.
    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, RelicError::InvalidAmount);
        let vault = &mut ctx.accounts.vault;
        let remaining = vault
            .collateral
            .checked_sub(amount)
            .ok_or(RelicError::InsufficientCollateral)?;
        require!(
            credit_line(remaining)? >= vault.debt,
            RelicError::ExceedsCreditLine
        );
        vault.collateral = remaining;

        let seeds: &[&[u8]] = &[SEED_POOL, &[ctx.accounts.pool.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.collateral.to_account_info(),
                    to: ctx.accounts.owner_usdc.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    /// Owner writes the agent's job description: budget, per-purchase cap,
    /// approved merchants, expiry.
    pub fn create_mandate(ctx: Context<CreateMandate>, params: MandateParams) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_params(&params, now)?;
        require!(
            ctx.accounts.agent.key() != ctx.accounts.owner.key(),
            RelicError::InvalidMandate
        );

        let mandate = &mut ctx.accounts.mandate;
        mandate.owner = ctx.accounts.owner.key();
        mandate.agent = ctx.accounts.agent.key();
        mandate.spent = 0;
        mandate.purchases = 0;
        mandate.revoked = false;
        mandate.created_at = now;
        mandate.bump = ctx.bumps.mandate;
        apply_params(mandate, params);

        emit!(MandateSet {
            mandate: mandate.key(),
            owner: mandate.owner,
            agent: mandate.agent,
            budget: mandate.budget,
            per_purchase_cap: mandate.per_purchase_cap,
            expires_at: mandate.expires_at,
        });
        Ok(())
    }

    /// Owner changes an active mandate's limits. The agent cannot call this.
    pub fn update_mandate(ctx: Context<OwnerMandate>, params: MandateParams) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_params(&params, now)?;
        let mandate = &mut ctx.accounts.mandate;
        require!(!mandate.revoked, RelicError::MandateRevoked);
        apply_params(mandate, params);

        emit!(MandateSet {
            mandate: mandate.key(),
            owner: mandate.owner,
            agent: mandate.agent,
            budget: mandate.budget,
            per_purchase_cap: mandate.per_purchase_cap,
            expires_at: mandate.expires_at,
        });
        Ok(())
    }

    /// The big red button. Terminal: write a new mandate to re-enable.
    pub fn revoke_mandate(ctx: Context<OwnerMandate>) -> Result<()> {
        let mandate = &mut ctx.accounts.mandate;
        mandate.revoked = true;
        emit!(MandateRevokedEvent {
            mandate: mandate.key(),
            owner: mandate.owner,
            agent: mandate.agent,
        });
        Ok(())
    }

    /// The agent buys now, pay later for its owner. Signed ONLY by the agent
    /// key. Every rule is checked before any USDC moves.
    pub fn agent_purchase(ctx: Context<AgentPurchase>, amount: u64, reason: String) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let merchant = ctx.accounts.merchant.key();
        let mandate = &mut ctx.accounts.mandate;
        let vault = &mut ctx.accounts.vault;

        require!(!mandate.revoked, RelicError::MandateRevoked);
        require!(now < mandate.expires_at, RelicError::MandateExpired);
        require!(amount > 0, RelicError::InvalidAmount);
        require!(reason.len() <= MAX_REASON_LEN, RelicError::ReasonTooLong);
        require!(
            mandate.allowed_merchants.contains(&merchant),
            RelicError::MerchantNotAllowed
        );
        require!(
            amount <= mandate.per_purchase_cap,
            RelicError::OverPurchaseCap
        );
        let spent = mandate
            .spent
            .checked_add(amount)
            .ok_or(RelicError::MathOverflow)?;
        require!(spent <= mandate.budget, RelicError::OverBudget);
        let debt = vault
            .debt
            .checked_add(amount)
            .ok_or(RelicError::MathOverflow)?;
        let line = credit_line(vault.collateral)?;
        require!(debt <= line, RelicError::ExceedsCreditLine);
        require!(
            ctx.accounts.liquidity.amount >= amount,
            RelicError::InsufficientPoolLiquidity
        );

        // Effects before the transfer.
        let index = mandate.purchases;
        mandate.spent = spent;
        mandate.purchases = index.checked_add(1).ok_or(RelicError::MathOverflow)?;
        vault.debt = debt;
        vault.total_borrowed = vault
            .total_borrowed
            .checked_add(amount)
            .ok_or(RelicError::MathOverflow)?;
        vault.purchases = vault
            .purchases
            .checked_add(1)
            .ok_or(RelicError::MathOverflow)?;
        let pool = &mut ctx.accounts.pool;
        pool.total_lent = pool
            .total_lent
            .checked_add(amount)
            .ok_or(RelicError::MathOverflow)?;

        let agreement = &mut ctx.accounts.agreement;
        agreement.owner = mandate.owner;
        agreement.agent = mandate.agent;
        agreement.mandate = mandate.key();
        agreement.merchant = merchant;
        agreement.amount_owed = amount;
        agreement.amount_repaid = 0;
        agreement.status = STATUS_OPEN;
        agreement.index = index;
        agreement.created_at = now;
        agreement.reason = reason.clone();
        agreement.bump = ctx.bumps.agreement;

        // The pool pays the merchant up front.
        let seeds: &[&[u8]] = &[SEED_POOL, &[pool.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.liquidity.to_account_info(),
                    to: ctx.accounts.merchant_usdc.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(AgentPurchased {
            mandate: mandate.key(),
            agreement: agreement.key(),
            owner: mandate.owner,
            agent: mandate.agent,
            merchant,
            amount,
            reason,
            mandate_remaining: mandate.budget.saturating_sub(mandate.spent),
            debt: vault.debt,
            credit_line: line,
        });
        Ok(())
    }

    /// Owner repays the pool on one agreement. A fully repaid agreement
    /// adds to the owner's on-chain trust record.
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        require!(amount > 0, RelicError::InvalidAmount);
        let agreement = &mut ctx.accounts.agreement;
        require!(agreement.status == STATUS_OPEN, RelicError::AlreadyRepaid);
        let outstanding = agreement
            .amount_owed
            .checked_sub(agreement.amount_repaid)
            .ok_or(RelicError::MathOverflow)?;
        require!(amount <= outstanding, RelicError::OverRepay);

        agreement.amount_repaid = agreement
            .amount_repaid
            .checked_add(amount)
            .ok_or(RelicError::MathOverflow)?;
        let vault = &mut ctx.accounts.vault;
        vault.debt = vault
            .debt
            .checked_sub(amount)
            .ok_or(RelicError::MathOverflow)?;
        vault.total_repaid = vault
            .total_repaid
            .checked_add(amount)
            .ok_or(RelicError::MathOverflow)?;
        if agreement.amount_repaid == agreement.amount_owed {
            agreement.status = STATUS_REPAID;
            vault.loans_repaid = vault
                .loans_repaid
                .checked_add(1)
                .ok_or(RelicError::MathOverflow)?;
        }
        let pool = &mut ctx.accounts.pool;
        pool.total_repaid = pool
            .total_repaid
            .checked_add(amount)
            .ok_or(RelicError::MathOverflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_usdc.to_account_info(),
                    to: ctx.accounts.liquidity.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(Repaid {
            agreement: agreement.key(),
            owner: vault.owner,
            amount,
            outstanding: agreement.amount_owed.saturating_sub(agreement.amount_repaid),
            debt: vault.debt,
            loans_repaid: vault.loans_repaid,
        });
        Ok(())
    }
}

fn validate_params(p: &MandateParams, now: i64) -> Result<()> {
    require!(
        !p.allowed_merchants.is_empty() && p.allowed_merchants.len() <= MAX_MERCHANTS,
        RelicError::TooManyMerchants
    );
    require!(
        p.per_purchase_cap > 0 && p.budget >= p.per_purchase_cap && p.expires_at > now,
        RelicError::InvalidMandate
    );
    Ok(())
}

fn apply_params(m: &mut Mandate, p: MandateParams) {
    m.budget = p.budget;
    m.per_purchase_cap = p.per_purchase_cap;
    m.expires_at = p.expires_at;
    m.allowed_merchants = p.allowed_merchants;
}

// ─── State ───────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub total_lent: u64,
    pub total_repaid: u64,
    pub bump: u8,
}

/// One per owner: collateral, debt, and the trust record.
#[account]
#[derive(InitSpace)]
pub struct CreditVault {
    pub owner: Pubkey,
    pub collateral: u64,
    pub debt: u64,
    pub total_borrowed: u64,
    pub total_repaid: u64,
    pub purchases: u32,
    pub loans_repaid: u32,
    pub bump: u8,
}

/// The agent's written job description.
#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub budget: u64,
    pub per_purchase_cap: u64,
    pub spent: u64,
    pub expires_at: i64,
    pub revoked: bool,
    pub purchases: u32,
    #[max_len(5)]
    pub allowed_merchants: Vec<Pubkey>,
    pub created_at: i64,
    pub bump: u8,
}

/// One agent purchase: what the owner owes the pool for it.
#[account]
#[derive(InitSpace)]
pub struct Agreement {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub mandate: Pubkey,
    pub merchant: Pubkey,
    pub amount_owed: u64,
    pub amount_repaid: u64,
    pub status: u8,
    pub index: u32,
    pub created_at: i64,
    #[max_len(64)]
    pub reason: String,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MandateParams {
    pub budget: u64,
    pub per_purchase_cap: u64,
    pub expires_at: i64,
    pub allowed_merchants: Vec<Pubkey>,
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ RelicError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,

    #[account(init, payer = authority, space = 8 + Pool::INIT_SPACE, seeds = [SEED_POOL], bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = authority,
        seeds = [SEED_MOCK_USDC],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = pool,
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [SEED_LIQUIDITY],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub liquidity: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [SEED_COLLATERAL],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub collateral: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [SEED_POOL], bump = pool.bump, has_one = mint)]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + CreditVault::INIT_SPACE,
        seeds = [SEED_VAULT, owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, token::mint = pool.mint, token::authority = owner)]
    pub owner_usdc: Account<'info, TokenAccount>,

    #[account(mut, seeds = [SEED_COLLATERAL], bump)]
    pub collateral: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_VAULT, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ RelicError::NotVaultOwner
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, token::mint = pool.mint, token::authority = owner)]
    pub owner_usdc: Account<'info, TokenAccount>,

    #[account(mut, seeds = [SEED_COLLATERAL], bump)]
    pub collateral: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// A mandate needs a credit vault behind it.
    #[account(
        seeds = [SEED_VAULT, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ RelicError::NotVaultOwner
    )]
    pub vault: Account<'info, CreditVault>,

    /// CHECK: The agent's public key. Stored only; it signs purchases later.
    pub agent: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [SEED_MANDATE, owner.key().as_ref(), agent.key().as_ref()],
        bump
    )]
    pub mandate: Account<'info, Mandate>,

    pub system_program: Program<'info, System>,
}

/// Owner-only mandate changes (update, revoke). `has_one = owner` with the
/// owner as a required signer is what stops an agent from raising its own
/// limits or revoking/un-revoking anything.
#[derive(Accounts)]
pub struct OwnerMandate<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_MANDATE, mandate.owner.as_ref(), mandate.agent.as_ref()],
        bump = mandate.bump,
        has_one = owner @ RelicError::NotMandateOwner
    )]
    pub mandate: Account<'info, Mandate>,
}

#[derive(Accounts)]
pub struct AgentPurchase<'info> {
    /// The agent's scoped key: the only signer on a purchase.
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_MANDATE, mandate.owner.as_ref(), mandate.agent.as_ref()],
        bump = mandate.bump,
        has_one = agent @ RelicError::NotMandateAgent
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        mut,
        seeds = [SEED_VAULT, mandate.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(mut, seeds = [SEED_POOL], bump = pool.bump, has_one = mint)]
    pub pool: Account<'info, Pool>,

    pub mint: Account<'info, Mint>,

    #[account(mut, seeds = [SEED_LIQUIDITY], bump)]
    pub liquidity: Account<'info, TokenAccount>,

    /// CHECK: Checked against the mandate's approved merchants in the
    /// handler before any USDC moves.
    pub merchant: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = agent,
        associated_token::mint = mint,
        associated_token::authority = merchant,
    )]
    pub merchant_usdc: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = agent,
        space = 8 + Agreement::INIT_SPACE,
        seeds = [SEED_AGREEMENT, mandate.key().as_ref(), &mandate.purchases.to_le_bytes()],
        bump
    )]
    pub agreement: Account<'info, Agreement>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_VAULT, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ RelicError::NotVaultOwner
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        seeds = [SEED_AGREEMENT, agreement.mandate.as_ref(), &agreement.index.to_le_bytes()],
        bump = agreement.bump,
        has_one = owner @ RelicError::NotAgreementOwner
    )]
    pub agreement: Account<'info, Agreement>,

    #[account(mut, seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, token::mint = pool.mint, token::authority = owner)]
    pub owner_usdc: Account<'info, TokenAccount>,

    #[account(mut, seeds = [SEED_LIQUIDITY], bump)]
    pub liquidity: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ─── Events (the on-chain audit trail) ───────────────────────────────────────

#[event]
pub struct CollateralDeposited {
    pub owner: Pubkey,
    pub amount: u64,
    pub collateral: u64,
    pub credit_line: u64,
}

#[event]
pub struct MandateSet {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub budget: u64,
    pub per_purchase_cap: u64,
    pub expires_at: i64,
}

#[event]
pub struct MandateRevokedEvent {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
}

#[event]
pub struct AgentPurchased {
    pub mandate: Pubkey,
    pub agreement: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub reason: String,
    pub mandate_remaining: u64,
    pub debt: u64,
    pub credit_line: u64,
}

#[event]
pub struct Repaid {
    pub agreement: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub outstanding: u64,
    pub debt: u64,
    pub loans_repaid: u32,
}

// ─── Errors (plain English: the agent reads these back to the owner) ─────────

#[error_code]
pub enum RelicError {
    #[msg("Blocked: the owner revoked this agent's spending permission.")]
    MandateRevoked,
    #[msg("Blocked: this purchase is bigger than the agent's per-purchase limit.")]
    OverPurchaseCap,
    #[msg("Blocked: this purchase would go over the agent's total budget.")]
    OverBudget,
    #[msg("Blocked: this merchant is not on the owner's approved list.")]
    MerchantNotAllowed,
    #[msg("Blocked: the agent's spending permission has expired.")]
    MandateExpired,
    #[msg("Blocked: this purchase would push debt past the 80% credit line.")]
    ExceedsCreditLine,
    #[msg("Only the owner can change or revoke this mandate.")]
    NotMandateOwner,
    #[msg("This key is not the agent named in the mandate.")]
    NotMandateAgent,
    #[msg("Only the owner can use this credit vault.")]
    NotVaultOwner,
    #[msg("Only the owner can repay this agreement.")]
    NotAgreementOwner,
    #[msg("Only the program's deployer can create the pool.")]
    NotUpgradeAuthority,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Mandate limits are invalid: cap must be above zero, budget at least the cap, expiry in the future, agent not the owner.")]
    InvalidMandate,
    #[msg("A mandate needs between 1 and 5 approved merchants.")]
    TooManyMerchants,
    #[msg("Purchase reason is longer than 64 characters.")]
    ReasonTooLong,
    #[msg("The pool does not have enough USDC for this purchase.")]
    InsufficientPoolLiquidity,
    #[msg("Not enough collateral to withdraw that much.")]
    InsufficientCollateral,
    #[msg("That is more than is owed on this agreement.")]
    OverRepay,
    #[msg("This agreement is already fully repaid.")]
    AlreadyRepaid,
    #[msg("The faucet gives between 0 and 1,000 mock USDC per request.")]
    FaucetLimit,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
}
