// Spike S0: OCCT 8.0 compatibility prelude for Gmsh 4.15.2's src/geo/GModelIO_OCC.cpp, injected by
// build-in-container.sh after the file's last OCC include.
//  - OCCT 8 headers include less transitively: TopTools_MapOfShape and
//    Interface_HArray1OfHAsciiString are no longer reachable from what Gmsh includes.
//  - The Handle_<Class> typedefs are gone ("The Handle() macro and ::DownCast are replaced with
//    explicit occ::handle<> / occ::down_cast<> templates", dox/upgrade/upgrade.md
//    §upgrade_800_handle); occ::handle<T>::DownCast still exists.
#pragma once
#include <HeaderSection_FileDescription.hxx>
#include <HeaderSection_FileName.hxx>
#include <HeaderSection_FileSchema.hxx>
#include <Interface_HArray1OfHAsciiString.hxx>
#include <Standard_Transient.hxx>
#include <StepData_StepModel.hxx>
#include <TCollection_HAsciiString.hxx>
#include <TopTools_MapOfShape.hxx>

typedef occ::handle<Interface_HArray1OfHAsciiString> Handle_Interface_HArray1OfHAsciiString;
typedef occ::handle<TCollection_HAsciiString> Handle_TCollection_HAsciiString;
typedef occ::handle<HeaderSection_FileName> Handle_HeaderSection_FileName;
typedef occ::handle<HeaderSection_FileDescription> Handle_HeaderSection_FileDescription;
typedef occ::handle<HeaderSection_FileSchema> Handle_HeaderSection_FileSchema;
typedef occ::handle<Standard_Transient> Handle_Standard_Transient;
typedef occ::handle<StepData_StepModel> Handle_StepData_StepModel;
