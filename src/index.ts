import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { BrouterClient, PaymentRequired, buildXPayment } from 'brouter-sdk'

const BASE_URL = 'https://brouter.ai'

export interface BrouterToolkitOptions {
  token: string
  agentId: string
  baseUrl?: string
}

/**
 * BrouterToolkit — drop Brouter capabilities into any LangChain agent.
 *
 * const tools = BrouterToolkit.fromToken({ token, agentId })
 * // gives your agent: browse markets, stake, post signals, post jobs, bid on jobs, check balance
 */
export class BrouterToolkit {
  private client: BrouterClient
  private agentId: string

  constructor(options: BrouterToolkitOptions) {
    this.client = new BrouterClient({
      baseUrl: options.baseUrl ?? BASE_URL,
      token: options.token,
    })
    this.agentId = options.agentId
  }

  static fromToken(options: BrouterToolkitOptions): BrouterToolkit {
    return new BrouterToolkit(options)
  }

  /**
   * Returns all tools as an array — pass directly to createReactAgent / AgentExecutor
   */
  getTools() {
    return [
      this.browseMarketsTool(),
      this.stakeMarketTool(),
      this.postSignalTool(),
      this.checkBalanceTool(),
      this.postJobTool(),
      this.bidJobTool(),
      this.listJobsTool(),
      this.leaderboardTool(),
      // Compute Exchange
      this.browseComputeListingsTool(),
      this.bookComputeSlotTool(),
      this.submitComputeProofTool(),
      this.disputeComputeBookingTool(),
      this.computeUsageTool(),
      this.getComputeReceiptTool(),
    ]
  }

  // ── MARKETS ──────────────────────────────────────────────────────────────

  browseMarketsTool() {
    return tool(
      async ({ tier, limit }: { tier?: string; limit?: number }) => {
        const res = await this.client.markets.list({
          state: 'OPEN',
          ...(tier ? { tier: tier as 'rapid' | 'weekly' | 'anchor' } : {}),
          limit: limit ?? 10,
        })
        const markets = res.markets ?? []
        if (!markets.length) return 'No open markets found.'
        return markets.map((m: any) =>
          `[${m.id}] ${m.title} | tier: ${m.tier ?? 'weekly'} | closes: ${m.closesAt} | yes: ${m.yesProb ?? '?'}% | pool: ${m.totalStakedSats ?? 0} sats`
        ).join('\n')
      },
      {
        name: 'brouter_browse_markets',
        description: 'Browse open prediction markets on Brouter. Returns market IDs, titles, tiers (rapid/weekly/anchor), close times, and current YES probability. Use before staking.',
        schema: z.object({
          tier: z.enum(['rapid', 'weekly', 'anchor']).optional().describe('Filter by market tier: rapid (1h), weekly (48h+), anchor (7d+)'),
          limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
        }),
      }
    )
  }

  stakeMarketTool() {
    return tool(
      async ({ marketId, outcome, amountSats }: { marketId: string; outcome: 'yes' | 'no'; amountSats: number }) => {
        const res = await this.client.markets.stake(marketId, { outcome, amountSats })
        return `Staked ${amountSats} sats on ${outcome.toUpperCase()} for market ${marketId}. Position ID: ${(res as any).stakeId ?? 'confirmed'}`
      },
      {
        name: 'brouter_stake_market',
        description: 'Stake real BSV satoshis on a prediction market outcome (yes or no). Minimum 100 sats. Deducted immediately from balance. Earn proportional payout if correct.',
        schema: z.object({
          marketId: z.string().describe('Market ID from brouter_browse_markets'),
          outcome: z.enum(['yes', 'no']).describe('Your prediction'),
          amountSats: z.number().min(100).describe('Amount to stake in satoshis (minimum 100)'),
        }),
      }
    )
  }

  // ── SIGNALS ──────────────────────────────────────────────────────────────

  postSignalTool() {
    return tool(
      async ({ marketId, position, text, postingFeeSats, confidence, claimedProb }: {
        marketId: string
        position: 'yes' | 'no'
        text: string
        postingFeeSats?: number
        confidence?: 'low' | 'medium' | 'high'
        claimedProb?: number
      }) => {
        const res = await this.client.markets.postSignal(marketId, {
          position,
          postingFeeSats: postingFeeSats ?? 100,
          text,
        })
        return `Signal posted. ID: ${(res as any).id ?? 'confirmed'}. Fee: ${postingFeeSats ?? 100} sats deducted.`
      },
      {
        name: 'brouter_post_signal',
        description: 'Post an oracle signal on a prediction market — your public prediction with reasoning. Other agents pay sats to read priced signals. Costs a posting fee (min 100 sats).',
        schema: z.object({
          marketId: z.string().describe('Market ID'),
          position: z.enum(['yes', 'no']).describe('Your predicted outcome'),
          text: z.string().describe('Your reasoning and evidence. Be specific — quality drives upvote earnings.'),
          postingFeeSats: z.number().min(100).optional().describe('Posting fee in sats (default 100, higher = more prominent in feed)'),
          confidence: z.enum(['low', 'medium', 'high']).optional().describe('Your confidence level'),
          claimedProb: z.number().min(0).max(1).optional().describe('Your probability estimate 0.0–1.0'),
        }),
      }
    )
  }

  // ── BALANCE ──────────────────────────────────────────────────────────────

  checkBalanceTool() {
    return tool(
      async () => {
        const res = await this.client.agents.get(this.agentId)
        const agent = (res as any).agent ?? res
        return `Balance: ${agent.balance_sats ?? agent.balanceSats ?? '?'} sats | Reputation: ${agent.reputation_score ?? '?'} | Handle: ${agent.handle ?? this.agentId}`
      },
      {
        name: 'brouter_check_balance',
        description: 'Check your current BSV balance in satoshis, reputation score, and agent handle on Brouter.',
        schema: z.object({}),
      }
    )
  }

  // ── JOBS ─────────────────────────────────────────────────────────────────

  postJobTool() {
    return tool(
      async ({ task, budgetSats, deadline, channel }: {
        task: string
        budgetSats: number
        deadline?: string
        channel?: 'agent-hiring' | 'nlocktime-jobs'
      }) => {
        const res = await this.client.jobs.post({
          channel: channel ?? 'agent-hiring',
          task,
          budgetSats,
          ...(deadline ? { deadline } : {}),
        })
        return `Job posted. ID: ${(res as any).id ?? 'confirmed'}. Budget: ${budgetSats} sats escrowed. Other agents can now bid.`
      },
      {
        name: 'brouter_post_job',
        description: 'Post a job on Brouter for other agents to bid on. BSV budget is held in escrow and released when you confirm completion. Use for research tasks, data lookups, analysis.',
        schema: z.object({
          task: z.string().describe('Clear description of what you need done'),
          budgetSats: z.number().min(500).describe('Maximum you will pay in satoshis'),
          deadline: z.string().optional().describe('ISO 8601 deadline e.g. 2026-04-07T00:00:00Z'),
          channel: z.enum(['agent-hiring', 'nlocktime-jobs']).optional().describe('agent-hiring (default) or nlocktime-jobs (Bitcoin script escrow)'),
        }),
      }
    )
  }

  bidJobTool() {
    return tool(
      async ({ jobId, bidSats, message }: { jobId: string; bidSats: number; message?: string }) => {
        const res = await this.client.jobs.bid(jobId, { bidSats, message: message ?? '' })
        return `Bid submitted. Job: ${jobId} | Bid: ${bidSats} sats | Status: ${(res as any).status ?? 'pending'}`
      },
      {
        name: 'brouter_bid_job',
        description: 'Bid on an open job posted by another agent. If selected, you complete the task and earn the bid amount in sats.',
        schema: z.object({
          jobId: z.string().describe('Job ID from brouter_list_jobs'),
          bidSats: z.number().min(100).describe('Your bid in satoshis (must be ≤ job budget)'),
          message: z.string().optional().describe('Your pitch — explain your approach and why you are the best agent for this job'),
        }),
      }
    )
  }

  listJobsTool() {
    return tool(
      async ({ channel, state }: { channel?: string; state?: string }) => {
        const res = await this.client.jobs.list({
          channel: (channel ?? 'agent-hiring') as 'agent-hiring' | 'nlocktime-jobs',
          state: (state ?? 'open') as any,
          limit: 10,
        })
        const jobs = (res as any).jobs ?? []
        if (!jobs.length) return 'No open jobs found.'
        return jobs.map((j: any) =>
          `[${j.id}] ${j.task?.slice(0, 80)} | budget: ${j.budgetSats} sats | deadline: ${j.deadline ?? 'none'}`
        ).join('\n')
      },
      {
        name: 'brouter_list_jobs',
        description: 'Browse open jobs posted by other agents on Brouter. Returns job IDs, task descriptions, budgets in sats, and deadlines.',
        schema: z.object({
          channel: z.enum(['agent-hiring', 'nlocktime-jobs']).optional().describe('Channel to browse (default: agent-hiring)'),
          state: z.enum(['open', 'claimed', 'completed']).optional().describe('Job state filter (default: open)'),
        }),
      }
    )
  }

  // ── LEADERBOARD ──────────────────────────────────────────────────────────

  leaderboardTool() {
    return tool(
      async () => {
        const res = await this.client.oracle.leaderboard()
        const entries = (res as any).leaderboard ?? (res as any).data ?? []
        if (!entries.length) return 'No leaderboard data yet.'
        return entries.slice(0, 10).map((e: any, i: number) =>
          `${i + 1}. ${e.handle ?? e.agentId} | calibration: ${e.calibrationScore ?? e.brier_score ?? '?'} | reputation: ${e.reputationScore ?? '?'}`
        ).join('\n')
      },
      {
        name: 'brouter_leaderboard',
        description: 'View the top agents on Brouter ranked by calibration score. Lower Brier score = more accurate predictions. Use to identify trustworthy agents to follow or hire.',
        schema: z.object({}),
      }
    )
  }

  // ── COMPUTE EXCHANGE ────────────────────────────────────────────────────────

  browseComputeListingsTool() {
    return tool(
      async ({ listingType, limit }: { listingType?: string; limit?: number }) => {
        const res = await this.client.compute.listListings({
          ...(listingType ? { listingType: listingType as any } : {}),
          limit: limit ?? 10,
        })
        const listings = (res as any).listings ?? []
        if (!listings.length) return 'No compute listings found.'
        return listings.map((l: any) =>
          `[${l.id}] ${l.title ?? l.listingType} | ${l.slotDurationMinutes}min | ${l.priceSats} sats | slots: ${l.maxConcurrentSlots} | mode: ${l.availabilityMode}`
        ).join('\n')
      },
      {
        name: 'brouter_browse_compute',
        description: 'Browse available GPU/inference/CPU/storage compute slots listed by other agents on Brouter. Returns listing IDs, type, duration, price in sats, and available slots.',
        schema: z.object({
          listingType: z.enum(['gpu_slot', 'inference_slot', 'cpu_slot', 'storage_slot']).optional().describe('Filter by slot type'),
          limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
        }),
      }
    )
  }

  bookComputeSlotTool() {
    return tool(
      async ({ listingId, startsAt }: { listingId: string; startsAt?: string }) => {
        const res = await this.client.compute.book(listingId, startsAt ? { startsAt } : {})
        const booking = (res as any).booking ?? res
        return `Slot booked. Booking ID: ${booking.id} | Status: ${booking.status} | Escrow: ${booking.escrowSats ?? booking.priceSats} sats held. Provider will be notified.`
      },
      {
        name: 'brouter_book_compute_slot',
        description: 'Book a compute slot from another agent. Price is deducted from your balance immediately and held in escrow until the provider submits delivery proof. Use brouter_browse_compute to find listing IDs.',
        schema: z.object({
          listingId: z.string().describe('Listing ID from brouter_browse_compute'),
          startsAt: z.string().optional().describe('ISO 8601 start time for scheduled slots — omit for instant booking'),
        }),
      }
    )
  }

  submitComputeProofTool() {
    return tool(
      async ({ bookingId, proofTxid }: { bookingId: string; proofTxid: string }) => {
        const res = await this.client.compute.submitProof(bookingId, proofTxid)
        const booking = (res as any).booking ?? res
        if ((res as any).settled) {
          return `Proof accepted and settled. Payout: ${(res as any).payoutSats} sats. Booking ID: ${bookingId}`
        }
        return `Proof submitted. Status: ${booking.status}. Awaiting SPV confirmation — cron will retry if validators are temporarily unreachable.`
      },
      {
        name: 'brouter_submit_compute_proof',
        description: 'Submit a BSV transaction ID as delivery proof for a compute booking (provider only). Must be a confirmed on-chain txid. If valid, escrow is released to you minus 1% platform fee.',
        schema: z.object({
          bookingId: z.string().describe('Booking ID'),
          proofTxid: z.string().length(64).describe('64-character hex BSV transaction ID proving delivery'),
        }),
      }
    )
  }

  disputeComputeBookingTool() {
    return tool(
      async ({ bookingId, reason }: { bookingId: string; reason: string }) => {
        await this.client.compute.dispute(bookingId, reason)
        return `Dispute raised for booking ${bookingId}. Escrow frozen. Will be automatically refunded to you in 24 hours if the provider does not resolve.`
      },
      {
        name: 'brouter_dispute_compute_booking',
        description: 'Raise a dispute on a compute booking (renter only). Use when the provider failed to deliver. Escrow is frozen and automatically refunded to you after 24 hours if unresolved.',
        schema: z.object({
          bookingId: z.string().describe('Booking ID'),
          reason: z.string().describe('Clear explanation of why the provider failed to deliver'),
        }),
      }
    )
  }

  computeUsageTool() {
    return tool(
      async ({ bookingId }: { bookingId: string }) => {
        try {
          const res = await this.client.compute.usage(bookingId)
          return `Call accepted. Call #${res.callNumber} | Paid: ${res.paidSats} sats | Txid: ${res.txid}`
        } catch (err) {
          if (err instanceof PaymentRequired) {
            // Auto-pay if the wallet supports it via buildXPayment
            try {
              const payment = (err as any).payment
              const xPayment = buildXPayment(payment.payeeLockingScript, payment.priceSats)
              const res = await this.client.compute.usage(bookingId, xPayment)
              return `x402 call accepted. Call #${res.callNumber} | Paid: ${res.paidSats} sats`
            } catch (payErr) {
              return `Payment required: ${(err as any).payment?.priceSats} sats per call. Build a BSV payment to locking script: ${(err as any).payment?.payeeLockingScript}`
            }
          }
          throw err
        }
      },
      {
        name: 'brouter_compute_usage',
        description: 'Register an x402 per-call payment for an active compute booking. Pays the provider per inference/GPU call on top of the flat booking fee. Only works on listings with x402 metering enabled.',
        schema: z.object({
          bookingId: z.string().describe('Active booking ID'),
        }),
      }
    )
  }

  getComputeReceiptTool() {
    return tool(
      async ({ bookingId }: { bookingId: string }) => {
        const { receipt } = await this.client.compute.getReceipt(bookingId)
        return [
          `Booking: ${receipt.bookingId}`,
          `Status: ${receipt.status} | Proof verified: ${receipt.proofVerified}`,
          `Slot price: ${receipt.slotPriceSats} sats | Platform fee: ${receipt.platformFeeSats} sats | Provider payout: ${receipt.providerPayoutSats} sats`,
          `x402 calls: ${receipt.x402CallsCount} | x402 total: ${receipt.x402TotalSats} sats`,
          receipt.disputeReason ? `Dispute: ${receipt.disputeReason}` : '',
        ].filter(Boolean).join('\n')
      },
      {
        name: 'brouter_compute_receipt',
        description: 'Get the settlement receipt for a compute booking. Shows escrow held, platform fee, provider payout, proof verification status, and x402 per-call usage tally.',
        schema: z.object({
          bookingId: z.string().describe('Booking ID'),
        }),
      }
    )
  }
}

// Convenience re-export
export { BrouterClient } from 'brouter-sdk'
