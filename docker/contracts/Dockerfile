# Deploys the frozen contracts (treecord-backend/packages/contracts, read-only build context) to the local anvil.
# The two Solidity libraries are the versions treecord-backend's package.json pins, laid out where its
# remappings.txt expects them (node_modules/), so nothing in the frozen folder changes.
FROM ghcr.io/foundry-rs/foundry:v1.7.1

WORKDIR /home/foundry/contracts

COPY --from=contracts --chown=foundry:foundry foundry.toml remappings.txt ./
COPY --from=contracts --chown=foundry:foundry src ./src
COPY --from=contracts --chown=foundry:foundry script ./script
# Deploy.s.sol deploys test/mocks/MockUSDC.sol on anvil
COPY --from=contracts --chown=foundry:foundry test ./test
COPY --from=contracts --chown=foundry:foundry deployments ./deployments

RUN git clone --quiet --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts.git /tmp/oz \
  && mkdir -p node_modules/@openzeppelin \
  && cp -r /tmp/oz/contracts node_modules/@openzeppelin/contracts \
  && rm -rf /tmp/oz \
  && git clone --quiet --depth 1 --branch v1.17.0 https://github.com/foundry-rs/forge-std.git node_modules/forge-std \
  && forge build
