import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { PrivyProvider } from "@privy-io/react-auth";
import { arbitrum, arbitrumSepolia } from "viem/chains";

const privyAppId =
  import.meta.env.VITE_PRIVY_APP_ID ||
  import.meta.env.VITE_PRIVY_APP ||
  "your-privy-app-id";

createRoot(document.getElementById("root")!).render(
  <PrivyProvider
    appId={privyAppId}
    config={{
      supportedChains: [arbitrumSepolia, arbitrum],
      defaultChain: arbitrumSepolia,
      loginMethods: ["wallet"],
      embeddedWallets: {
        ethereum: {
          createOnLogin: "users-without-wallets",
        },
      },
      appearance: {
        theme: "dark",
        accentColor: "#E8C15A",
      },
    }}
  >
    <App />
  </PrivyProvider>,
);
