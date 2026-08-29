# TabTin Public Roadmap

[中文](ROADMAP.md)

TabTin is currently in Public Preview. This roadmap describes the problems we are working on and the directions we have confirmed. It does not establish fixed release dates or feature commitments. Priorities and implementation details will continue to evolve based on real-world use, verification results, and community feedback.

## 1. Current status

TabTin already includes desktop and mobile clients, Community Server, Agent Runtime, real-time collaboration, and multiple work applications. Individuals and teams can use it for real work and carry tasks and results forward between members.

The current version still has several boundaries to improve:

- Components differ in maturity and cross-platform consistency.
- Community Server is currently intended primarily for local use.
- Mobile clients do not provide an independent Agent execution environment.
- Project capabilities are still under development.
- Some modules have usable default implementations, but replacing and extending them still requires substantial effort.

## 2. Next priorities

### 2.1 Improve the core experience

We will continue improving the reliability and consistency of the desktop and mobile clients, Community Server, and work applications while reducing uncertainty during installation, configuration, and daily use. Work that can already be completed should become easier to run, understand, and verify.

### 2.2 Build a pluggable extension system

Some foundational modules currently use default implementations so that users can experience the complete workflow. IM is one example: the current version provides a usable default capability, but replacing it with another service still requires developers to understand and modify substantial internal code.

Building a pluggable extension system is a confirmed direction. We want to support three levels over time:

- Deployers can select different implementations through configuration.
- Developers can build adapters against stable interfaces.
- Users or administrators can install, enable, and switch extensions.

This direction will gradually cover models, IM, storage, search, real-time collaboration, work applications, and the Agent Harness. The order, interface design, and supported scope for each module will change as we validate them in practice.

We want one open core to adapt to models, infrastructure services, deployment environments, and work applications across different regions.

### 2.3 Deepen individual and team collaboration with Agents

For individuals, TabTin will continue improving how different Agents, models, Skills, and execution rules participate in real work.

For teams, we will keep making work easier to hand off, methods easier to reuse, results easier to work on together, and execution and delivery easier to inspect and govern. Project is a focus for the next version, while its exact product shape will continue to be validated through real use.

## 3. Long-term exploration

TabTin's long-term goal is not to define one universal way for people and Agents to collaborate. It is to provide an open foundation that can continue to evolve.

We welcome communities around the world to use TabTin, report real problems, share how individuals and teams work with Agents, or contribute code, documentation, translations, tests, Skills, work applications, and third-party adapters.

We hope to explore better ways of collaborating in the AI era with everyone who is rethinking how work should happen.
