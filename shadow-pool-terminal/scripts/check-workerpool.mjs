import { IExec } from 'iexec';
import { Wallet, JsonRpcProvider } from 'ethers';

const RPC_URL = "https://arb-sepolia.g.alchemy.com/v2/lB78AtqzCmwOOeJqlKXYa";
// Using a random key just for reading public orderbook - not spending funds
const PRIVATE_KEY = "0x56803719180c7b917cc6fde634712ffa4b6da4260fc2fc55c6107c57de2860cd";
const WORKERPOOL_ADDRESS = "0xB967057a21dc6A66A29721d96b8Aa7454B7c383F"; // Default from relayer.mjs

const provider = new JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);
const iexec = new IExec({ ethProvider: wallet }, { allowExperimentalNetworks: true });

async function main() {
  console.log(`Checking orderbook for workerpool: ${WORKERPOOL_ADDRESS}`);
  try {
    const orderbook = await iexec.orderbook.fetchWorkerpoolOrderbook({
      workerpool: WORKERPOOL_ADDRESS,
      minTag: ['tee', 'scone'], // Matches relayer requirements
      maxTag: ['tee', 'scone']
    });
    
    console.log(`Total orders found: ${orderbook?.orders?.length || 0}`);
    
    if (orderbook?.orders?.length > 0) {
      const prices = orderbook.orders.map(o => o.order.workerpoolprice);
      console.log("Available prices (nRLC):", prices);
      console.log("Lowest price:", Math.min(...prices));
    } else {
      console.log("No orders found for this workerpool with TEE/Scone tags.");
    }
  } catch (e) {
    console.error("Error fetching orderbook:", e);
  }
}

main();
