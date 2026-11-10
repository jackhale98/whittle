// Spike S0: OCCT 8.0 removed the Geom2dLProp package ("consolidated into the unified GeomLProp
// template classes", dox/upgrade/upgrade.md §upgrade_800_lprop_gprop). Gmsh 4.15.2
// (src/geo/OCCEdge.cpp) still includes this header; map the old name onto the new alias.
#pragma once
#include <GeomLProp_CLProps.hxx>
using Geom2dLProp_CLProps2d = GeomLProp_CLProps2d;
